use hdbscan::{DistanceMetric, Hdbscan, HdbscanHyperParams};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use zeroize::Zeroizing;

pub const SPEAKER_EMBEDDING_DIMENSION: usize = 512;
pub const DEFAULT_SAMPLE_RATE: u32 = 16_000;
pub const DEFAULT_WINDOW_SAMPLES: u64 = 68 * DEFAULT_SAMPLE_RATE as u64;
pub const DEFAULT_OVERLAP_SAMPLES: u64 = 11 * DEFAULT_SAMPLE_RATE as u64;

const MAX_WINDOWS: usize = 512;
const MAX_LOCAL_SPEAKERS_PER_WINDOW: usize = 32;
const MAX_SEGMENTS_PER_WINDOW: usize = 16_384;
const MAX_GLOBAL_PROTOTYPES: usize = 2_048;
const GLOBAL_MIN_CLUSTER_SIZE: usize = 2;
const GLOBAL_MIN_SAMPLES: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BoundedDiarizationConfig {
    pub window_samples: u64,
    pub overlap_samples: u64,
    pub window_merge_distance: f32,
    pub global_same_speaker_distance: f32,
}

impl Default for BoundedDiarizationConfig {
    fn default() -> Self {
        Self {
            window_samples: DEFAULT_WINDOW_SAMPLES,
            overlap_samples: DEFAULT_OVERLAP_SAMPLES,
            window_merge_distance: 0.75,
            global_same_speaker_distance: 0.50,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowSpec {
    pub index: u32,
    pub start_sample: u64,
    pub end_sample: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalSegment {
    pub start_sample: u64,
    pub end_sample: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LocalSpeakerObservation {
    pub local_speaker: u32,
    pub embedding: Vec<f32>,
    pub segments: Vec<LocalSegment>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowObservation {
    pub window: WindowSpec,
    pub speakers: Vec<LocalSpeakerObservation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpeakerAssignment {
    pub window_index: u32,
    pub local_speaker: u32,
    pub global_speaker: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GlobalSpeakerSegment {
    pub start_sample: u64,
    pub end_sample: u64,
    pub global_speaker: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiarizationProjection {
    pub speaker_count: u32,
    pub assignments: Vec<SpeakerAssignment>,
    pub segments: Vec<GlobalSpeakerSegment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiarizationError {
    InvalidConfiguration,
    InvalidDuration,
    WindowPlanMismatch,
    ResourceLimit,
    DuplicateLocalSpeaker,
    InvalidEmbedding,
    InvalidSegment,
    InvalidClusterLabels,
}

#[derive(Debug, Clone)]
struct WindowPrototype {
    embedding: Vec<f32>,
    members: Vec<usize>,
}

#[derive(Debug, Clone)]
struct PrototypeIdentity {
    window_index: u32,
    local_speakers: Vec<u32>,
}

/// Returns the only accepted bounded window plan for a media stream.
///
/// The terminal-window break is intentional: a duration exactly covered by a
/// full window must not produce an extra overlap-only tail window.
pub fn bounded_window_plan(
    total_samples: u64,
    config: BoundedDiarizationConfig,
) -> Result<Vec<WindowSpec>, DiarizationError> {
    validate_config(config)?;
    if total_samples == 0 {
        return Err(DiarizationError::InvalidDuration);
    }

    let step = config.window_samples - config.overlap_samples;
    let mut windows = Vec::new();
    let mut start_sample = 0_u64;
    while start_sample < total_samples {
        if windows.len() == MAX_WINDOWS {
            return Err(DiarizationError::ResourceLimit);
        }
        let end_sample = start_sample
            .saturating_add(config.window_samples)
            .min(total_samples);
        windows.push(WindowSpec {
            index: windows.len() as u32,
            start_sample,
            end_sample,
        });
        if end_sample == total_samples {
            break;
        }
        start_sample = start_sample
            .checked_add(step)
            .ok_or(DiarizationError::InvalidDuration)?;
    }
    Ok(windows)
}

/// Consolidates per-window model output into stable Record-wide speaker IDs.
///
/// Inputs stay bounded to one embedding per local speaker and contain no PCM.
/// The worker may persist window observations between model invocations; this
/// final pass is therefore independent of media duration except for fixed
/// prototype and segment ceilings.
pub fn consolidate_diarization<F, G>(
    total_samples: u64,
    observations: &[WindowObservation],
    config: BoundedDiarizationConfig,
    mut cluster_embeddings: F,
    on_reconciling_started: G,
) -> Result<DiarizationProjection, DiarizationError>
where
    F: FnMut(&[Vec<f32>], f32) -> Result<Vec<u32>, DiarizationError>,
    G: FnOnce(),
{
    let planned = bounded_window_plan(total_samples, config)?;
    if observations.len() != planned.len()
        || observations
            .iter()
            .zip(&planned)
            .any(|(actual, expected)| actual.window != *expected)
    {
        return Err(DiarizationError::WindowPlanMismatch);
    }

    let mut prototypes = Zeroizing::new(Vec::new());
    let mut identities = Vec::new();
    let mut window_local_to_prototype = HashMap::new();
    let mut total_segments = 0_usize;

    for observation in observations {
        if observation.speakers.len() > MAX_LOCAL_SPEAKERS_PER_WINDOW {
            return Err(DiarizationError::ResourceLimit);
        }
        let window_length = observation.window.end_sample - observation.window.start_sample;
        let mut local_ids = BTreeMap::new();
        let mut embeddings = Zeroizing::new(Vec::with_capacity(observation.speakers.len()));
        let mut window_segments = 0_usize;
        for (speaker_index, speaker) in observation.speakers.iter().enumerate() {
            if local_ids
                .insert(speaker.local_speaker, speaker_index)
                .is_some()
            {
                return Err(DiarizationError::DuplicateLocalSpeaker);
            }
            window_segments = window_segments
                .checked_add(speaker.segments.len())
                .ok_or(DiarizationError::ResourceLimit)?;
            if window_segments > MAX_SEGMENTS_PER_WINDOW {
                return Err(DiarizationError::ResourceLimit);
            }
            for segment in &speaker.segments {
                if segment.start_sample >= segment.end_sample || segment.end_sample > window_length
                {
                    return Err(DiarizationError::InvalidSegment);
                }
            }
            embeddings.push(normalized_embedding(&speaker.embedding)?);
        }
        total_segments = total_segments
            .checked_add(window_segments)
            .ok_or(DiarizationError::ResourceLimit)?;

        let window_prototypes = if embeddings.is_empty() {
            Vec::new()
        } else {
            let labels = cluster_embeddings(&embeddings, config.window_merge_distance)?;
            labeled_prototypes(&embeddings, &labels)?
        };
        if prototypes.len().saturating_add(window_prototypes.len()) > MAX_GLOBAL_PROTOTYPES {
            return Err(DiarizationError::ResourceLimit);
        }
        for prototype in window_prototypes {
            let prototype_index = prototypes.len();
            let mut members = Vec::with_capacity(prototype.members.len());
            for member_index in prototype.members {
                let local_speaker = observation.speakers[member_index].local_speaker;
                members.push(local_speaker);
                window_local_to_prototype
                    .insert((observation.window.index, local_speaker), prototype_index);
            }
            identities.push(PrototypeIdentity {
                window_index: observation.window.index,
                local_speakers: members,
            });
            prototypes.push(prototype.embedding);
        }
    }

    let global_labels = global_cluster_labels(&prototypes, config.global_same_speaker_distance)?;
    on_reconciling_started();

    let mut assignments = Vec::new();
    for (prototype_index, identity) in identities.iter().enumerate() {
        for &local_speaker in &identity.local_speakers {
            assignments.push(SpeakerAssignment {
                window_index: identity.window_index,
                local_speaker,
                global_speaker: global_labels[prototype_index],
            });
        }
    }
    assignments
        .sort_unstable_by_key(|assignment| (assignment.window_index, assignment.local_speaker));

    let mut segments = Vec::with_capacity(total_segments);
    for (window_position, observation) in observations.iter().enumerate() {
        let owned_start = if window_position == 0 {
            observation.window.start_sample
        } else {
            midpoint(
                observation.window.start_sample,
                observations[window_position - 1].window.end_sample,
            )
        };
        let owned_end = if window_position + 1 == observations.len() {
            observation.window.end_sample
        } else {
            midpoint(
                observations[window_position + 1].window.start_sample,
                observation.window.end_sample,
            )
        };
        for speaker in &observation.speakers {
            let prototype_index =
                window_local_to_prototype[&(observation.window.index, speaker.local_speaker)];
            let global_speaker = global_labels[prototype_index];
            for segment in &speaker.segments {
                let absolute_start = observation
                    .window
                    .start_sample
                    .saturating_add(segment.start_sample)
                    .clamp(owned_start, owned_end);
                let absolute_end = observation
                    .window
                    .start_sample
                    .saturating_add(segment.end_sample)
                    .clamp(absolute_start, owned_end);
                if absolute_end > absolute_start {
                    segments.push(GlobalSpeakerSegment {
                        start_sample: absolute_start,
                        end_sample: absolute_end,
                        global_speaker,
                    });
                }
            }
        }
    }
    segments.sort_unstable_by_key(|segment| {
        (
            segment.start_sample,
            segment.end_sample,
            segment.global_speaker,
        )
    });
    segments = merge_adjacent_same_speaker(segments);

    let mut compact_labels = BTreeMap::new();
    for segment in &segments {
        let next_label = compact_labels.len() as u32;
        compact_labels
            .entry(segment.global_speaker)
            .or_insert(next_label);
    }
    for segment in &mut segments {
        segment.global_speaker = compact_labels[&segment.global_speaker];
    }
    assignments.retain(|assignment| compact_labels.contains_key(&assignment.global_speaker));
    for assignment in &mut assignments {
        assignment.global_speaker = compact_labels[&assignment.global_speaker];
    }

    Ok(DiarizationProjection {
        speaker_count: compact_labels.len() as u32,
        assignments,
        segments,
    })
}

fn validate_config(config: BoundedDiarizationConfig) -> Result<(), DiarizationError> {
    if config.window_samples == 0
        || config.window_samples > DEFAULT_WINDOW_SAMPLES
        || config.overlap_samples >= config.window_samples
        || config.overlap_samples > DEFAULT_OVERLAP_SAMPLES
        || !valid_distance(config.window_merge_distance)
        || !valid_distance(config.global_same_speaker_distance)
    {
        return Err(DiarizationError::InvalidConfiguration);
    }
    Ok(())
}

fn valid_distance(value: f32) -> bool {
    value.is_finite() && (0.0..2.0).contains(&value)
}

fn normalized_embedding(values: &[f32]) -> Result<Vec<f32>, DiarizationError> {
    if values.len() != SPEAKER_EMBEDDING_DIMENSION || values.iter().any(|value| !value.is_finite())
    {
        return Err(DiarizationError::InvalidEmbedding);
    }
    let squared_norm = values
        .iter()
        .map(|value| f64::from(*value) * f64::from(*value))
        .sum::<f64>();
    if !squared_norm.is_finite() || squared_norm <= f64::EPSILON {
        return Err(DiarizationError::InvalidEmbedding);
    }
    let norm = squared_norm.sqrt() as f32;
    Ok(values.iter().map(|value| *value / norm).collect())
}

fn labeled_prototypes(
    embeddings: &[Vec<f32>],
    labels: &[u32],
) -> Result<Vec<WindowPrototype>, DiarizationError> {
    validate_cluster_labels(embeddings.len(), labels)?;
    let mut members_by_label = BTreeMap::<u32, Vec<usize>>::new();
    for (index, label) in labels.iter().copied().enumerate() {
        members_by_label.entry(label).or_default().push(index);
    }
    Ok(members_by_label
        .into_values()
        .map(|members| WindowPrototype {
            embedding: normalized_centroid(&members, embeddings),
            members,
        })
        .collect())
}

fn validate_cluster_labels(embedding_count: usize, labels: &[u32]) -> Result<(), DiarizationError> {
    if labels.len() != embedding_count {
        return Err(DiarizationError::InvalidClusterLabels);
    }
    let distinct = labels.iter().copied().collect::<BTreeSet<_>>();
    if distinct
        .iter()
        .copied()
        .ne(0..u32::try_from(distinct.len()).map_err(|_| DiarizationError::ResourceLimit)?)
    {
        return Err(DiarizationError::InvalidClusterLabels);
    }
    Ok(())
}

/// Discovers Record-wide speaker groups without assuming a speaker count or a
/// single density threshold. HDBSCAN owns the generic density clustering; the
/// only product-specific policy here is how to project its explicit noise
/// points into a complete transcript speaker timeline.
fn global_cluster_labels(
    prototypes: &[Vec<f32>],
    same_speaker_distance: f32,
) -> Result<Vec<u32>, DiarizationError> {
    match prototypes.len() {
        0 => return Ok(Vec::new()),
        1 => return Ok(vec![0]),
        2 => {
            return Ok(
                if cosine_distance(&prototypes[0], &prototypes[1]) <= same_speaker_distance {
                    vec![0, 0]
                } else {
                    vec![0, 1]
                },
            );
        }
        _ => {}
    }

    let hyper_parameters = HdbscanHyperParams::builder()
        .min_cluster_size(GLOBAL_MIN_CLUSTER_SIZE)
        .min_samples(GLOBAL_MIN_SAMPLES)
        .allow_single_cluster(true)
        .epsilon(f64::from((2.0 * same_speaker_distance).sqrt()))
        .dist_metric(DistanceMetric::Euclidean)
        .build();
    let raw_labels = Hdbscan::new(prototypes, hyper_parameters)
        .cluster()
        .map_err(|_| DiarizationError::InvalidClusterLabels)?;
    if raw_labels.len() != prototypes.len() || raw_labels.iter().any(|label| *label < -1) {
        return Err(DiarizationError::InvalidClusterLabels);
    }

    let mut compact_by_raw = BTreeMap::new();
    let mut labels = vec![u32::MAX; prototypes.len()];
    let mut members = Vec::<Vec<usize>>::new();
    for (index, raw_label) in raw_labels.iter().copied().enumerate() {
        if raw_label < 0 {
            continue;
        }
        let next_label = compact_by_raw.len() as u32;
        let compact = *compact_by_raw.entry(raw_label).or_insert(next_label);
        if members.len() <= compact as usize {
            members.resize_with(compact as usize + 1, Vec::new);
        }
        members[compact as usize].push(index);
        labels[index] = compact;
    }
    let centroids = members
        .iter()
        .map(|cluster_members| normalized_centroid(cluster_members, prototypes))
        .collect::<Vec<_>>();

    let mut next_unique_label = centroids.len() as u32;
    for (index, label) in labels.iter_mut().enumerate() {
        if *label != u32::MAX {
            continue;
        }
        let nearest = centroids
            .iter()
            .enumerate()
            .map(|(cluster, centroid)| {
                (
                    cluster as u32,
                    cosine_distance(&prototypes[index], centroid),
                )
            })
            .min_by(
                |(left_label, left_distance), (right_label, right_distance)| {
                    left_distance
                        .total_cmp(right_distance)
                        .then_with(|| left_label.cmp(right_label))
                },
            );
        if let Some((cluster, distance)) = nearest
            && distance <= same_speaker_distance
        {
            *label = cluster;
        } else {
            *label = next_unique_label;
            next_unique_label = next_unique_label
                .checked_add(1)
                .ok_or(DiarizationError::ResourceLimit)?;
        }
    }
    let labels = compact_cluster_labels(&labels);
    validate_cluster_labels(prototypes.len(), &labels)?;
    Ok(labels)
}

fn compact_cluster_labels(labels: &[u32]) -> Vec<u32> {
    let mut compact = BTreeMap::new();
    labels
        .iter()
        .copied()
        .map(|label| {
            let next = compact.len() as u32;
            *compact.entry(label).or_insert(next)
        })
        .collect()
}

fn normalized_centroid(members: &[usize], embeddings: &[Vec<f32>]) -> Vec<f32> {
    let mut centroid = vec![0.0_f32; SPEAKER_EMBEDDING_DIMENSION];
    for &member in members {
        for (target, value) in centroid.iter_mut().zip(&embeddings[member]) {
            *target += *value;
        }
    }
    let norm = centroid
        .iter()
        .map(|value| value * value)
        .sum::<f32>()
        .sqrt();
    for value in &mut centroid {
        *value /= norm;
    }
    centroid
}

fn cosine_distance(left: &[f32], right: &[f32]) -> f32 {
    let similarity = left
        .iter()
        .zip(right)
        .map(|(left, right)| left * right)
        .sum::<f32>()
        .clamp(-1.0, 1.0);
    (1.0 - similarity).max(0.0)
}

fn midpoint(left: u64, right: u64) -> u64 {
    left + (right - left) / 2
}

fn merge_adjacent_same_speaker(segments: Vec<GlobalSpeakerSegment>) -> Vec<GlobalSpeakerSegment> {
    let mut merged: Vec<GlobalSpeakerSegment> = Vec::with_capacity(segments.len());
    for segment in segments {
        if let Some(previous) = merged.last_mut()
            && previous.global_speaker == segment.global_speaker
            && segment.start_sample <= previous.end_sample
        {
            previous.end_sample = previous.end_sample.max(segment.end_sample);
            continue;
        }
        merged.push(segment);
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn embedding(speaker: usize, drift: f32) -> Vec<f32> {
        let mut values = vec![0.0; SPEAKER_EMBEDDING_DIMENSION];
        values[speaker * 2] = 1.0;
        values[speaker * 2 + 1] = drift;
        values
    }

    fn observation_for_plan(plan: &[WindowSpec], speakers: usize) -> Vec<WindowObservation> {
        plan.iter()
            .map(|&window| WindowObservation {
                window,
                speakers: (0..speakers)
                    .map(|speaker| LocalSpeakerObservation {
                        local_speaker: speaker as u32,
                        embedding: embedding(speaker, window.index as f32 * 0.015),
                        segments: vec![LocalSegment {
                            start_sample: 0,
                            end_sample: window.end_sample - window.start_sample,
                        }],
                    })
                    .collect(),
            })
            .collect()
    }

    fn test_cluster(
        embeddings: &[Vec<f32>],
        _distance_threshold: f32,
    ) -> Result<Vec<u32>, DiarizationError> {
        let mut speaker_labels = BTreeMap::new();
        Ok(embeddings
            .iter()
            .map(|embedding| {
                let dominant_dimension = embedding
                    .iter()
                    .enumerate()
                    .max_by(|(_, left), (_, right)| left.abs().total_cmp(&right.abs()))
                    .map(|(index, _)| index)
                    .unwrap_or(0);
                let speaker = dominant_dimension / 2;
                let next_label = speaker_labels.len() as u32;
                *speaker_labels.entry(speaker).or_insert(next_label)
            })
            .collect())
    }

    #[test]
    fn frozen_short_corpora_keep_record_wide_speaker_identity() {
        let config = BoundedDiarizationConfig {
            window_samples: 1_000,
            overlap_samples: 100,
            ..BoundedDiarizationConfig::default()
        };
        let plan = bounded_window_plan(5_000, config).unwrap();
        for expected in [4, 2, 2, 2] {
            let projection = consolidate_diarization(
                5_000,
                &observation_for_plan(&plan, expected),
                config,
                test_cluster,
                || {},
            )
            .unwrap();
            assert_eq!(projection.speaker_count, expected as u32);
            for local_speaker in 0..expected as u32 {
                let labels = projection
                    .assignments
                    .iter()
                    .filter(|assignment| assignment.local_speaker == local_speaker)
                    .map(|assignment| assignment.global_speaker)
                    .collect::<Vec<_>>();
                assert!(labels.windows(2).all(|pair| pair[0] == pair[1]));
            }
        }
    }

    #[test]
    fn default_window_plan_keeps_eight_hours_within_the_window_budget() {
        let total_samples = 8 * 60 * 60 * DEFAULT_SAMPLE_RATE as u64;
        let plan = bounded_window_plan(total_samples, BoundedDiarizationConfig::default()).unwrap();
        assert_eq!(plan.len(), 506);
        assert!(plan.len() <= MAX_WINDOWS);
        assert_eq!(plan.first().unwrap().start_sample, 0);
        assert_eq!(plan.last().unwrap().end_sample, total_samples);
    }

    #[test]
    fn noisy_single_speaker_does_not_split_across_many_windows() {
        let config = BoundedDiarizationConfig {
            window_samples: 1_000,
            overlap_samples: 100,
            ..BoundedDiarizationConfig::default()
        };
        let plan = bounded_window_plan(50_000, config).unwrap();
        let observations = plan
            .iter()
            .map(|&window| WindowObservation {
                window,
                speakers: vec![LocalSpeakerObservation {
                    local_speaker: 0,
                    embedding: embedding(0, (window.index % 7) as f32 * 0.04),
                    segments: vec![LocalSegment {
                        start_sample: 0,
                        end_sample: window.end_sample - window.start_sample,
                    }],
                }],
            })
            .collect::<Vec<_>>();
        let projection =
            consolidate_diarization(50_000, &observations, config, test_cluster, || {}).unwrap();
        assert_eq!(projection.speaker_count, 1);
    }

    #[test]
    fn two_window_recording_keeps_each_speaker_record_wide() {
        let config = BoundedDiarizationConfig {
            window_samples: 1_000,
            overlap_samples: 100,
            ..BoundedDiarizationConfig::default()
        };
        let plan = bounded_window_plan(1_900, config).unwrap();
        assert_eq!(plan.len(), 2);
        let projection = consolidate_diarization(
            1_900,
            &observation_for_plan(&plan, 4),
            config,
            test_cluster,
            || {},
        )
        .unwrap();
        assert_eq!(projection.speaker_count, 4);
        for local_speaker in 0..4 {
            let labels = projection
                .assignments
                .iter()
                .filter(|assignment| assignment.local_speaker == local_speaker)
                .map(|assignment| assignment.global_speaker)
                .collect::<Vec<_>>();
            assert_eq!(labels.len(), 2);
            assert_eq!(labels[0], labels[1]);
        }
    }

    #[test]
    fn sparse_speaker_observations_survive_a_silent_window() {
        let config = BoundedDiarizationConfig {
            window_samples: 1_000,
            overlap_samples: 100,
            ..BoundedDiarizationConfig::default()
        };
        let plan = bounded_window_plan(2_800, config).unwrap();
        let mut observations = observation_for_plan(&plan, 1);
        observations[2].speakers.clear();
        let projection =
            consolidate_diarization(2_800, &observations, config, test_cluster, || {}).unwrap();
        assert_eq!(projection.speaker_count, 1);
        assert_eq!(projection.assignments.len(), 2);
        assert_eq!(
            projection.assignments[0].global_speaker,
            projection.assignments[1].global_speaker
        );
    }

    #[test]
    fn window_prototypes_consolidate_duplicate_local_speaker_labels() {
        let config = BoundedDiarizationConfig {
            window_samples: 1_000,
            overlap_samples: 100,
            ..BoundedDiarizationConfig::default()
        };
        let window = bounded_window_plan(1_000, config).unwrap()[0];
        let observations = vec![WindowObservation {
            window,
            speakers: vec![
                LocalSpeakerObservation {
                    local_speaker: 7,
                    embedding: embedding(0, 0.02),
                    segments: vec![LocalSegment {
                        start_sample: 0,
                        end_sample: 400,
                    }],
                },
                LocalSpeakerObservation {
                    local_speaker: 11,
                    embedding: embedding(0, -0.02),
                    segments: vec![LocalSegment {
                        start_sample: 600,
                        end_sample: 1_000,
                    }],
                },
            ],
        }];
        let projection =
            consolidate_diarization(1_000, &observations, config, test_cluster, || {}).unwrap();
        assert_eq!(projection.speaker_count, 1);
        assert_eq!(projection.assignments.len(), 2);
        assert_eq!(
            projection.assignments[0].global_speaker,
            projection.assignments[1].global_speaker
        );
    }

    #[test]
    fn rejects_invalid_cluster_labels() {
        let config = BoundedDiarizationConfig {
            window_samples: 1_000,
            overlap_samples: 100,
            ..BoundedDiarizationConfig::default()
        };
        let plan = bounded_window_plan(1_000, config).unwrap();
        assert_eq!(
            consolidate_diarization(
                1_000,
                &observation_for_plan(&plan, 2),
                config,
                |_, _| Ok(vec![2, 2]),
                || {},
            ),
            Err(DiarizationError::InvalidClusterLabels)
        );
    }

    #[test]
    fn delegates_only_window_duplicate_consolidation_to_native_hclust() {
        let config = BoundedDiarizationConfig {
            window_samples: 1_000,
            overlap_samples: 100,
            ..BoundedDiarizationConfig::default()
        };
        let plan = bounded_window_plan(1_000, config).unwrap();
        let mut observed = Vec::new();
        let mut reconciling_started = false;
        consolidate_diarization(
            1_000,
            &observation_for_plan(&plan, 1),
            config,
            |embeddings, _| {
                observed.push(embeddings.len());
                Ok(vec![0; embeddings.len()])
            },
            || reconciling_started = true,
        )
        .unwrap();
        assert_eq!(observed, vec![1]);
        assert!(reconciling_started);
    }

    #[test]
    fn hdbscan_discovers_record_wide_speakers_across_many_windows() {
        let prototypes = (0..4)
            .flat_map(|speaker| {
                (0..12).map(move |sample| embedding(speaker, (sample as f32 - 5.5) * 0.025))
            })
            .map(|values| normalized_embedding(&values).unwrap())
            .collect::<Vec<_>>();
        let labels = global_cluster_labels(&prototypes, 0.50).unwrap();
        assert_eq!(labels.iter().copied().collect::<BTreeSet<_>>().len(), 4);
        for speaker in 0..4 {
            assert!(
                labels[speaker * 12..(speaker + 1) * 12]
                    .iter()
                    .all(|label| *label == labels[speaker * 12])
            );
        }
    }

    #[test]
    fn hdbscan_keeps_a_far_noise_prototype_as_anonymous_speaker() {
        let mut prototypes = (0..2)
            .flat_map(|speaker| (0..6).map(move |sample| embedding(speaker, sample as f32 * 0.02)))
            .map(|values| normalized_embedding(&values).unwrap())
            .collect::<Vec<_>>();
        prototypes.push(normalized_embedding(&embedding(2, 0.0)).unwrap());
        let labels = global_cluster_labels(&prototypes, 0.50).unwrap();
        assert_eq!(labels.iter().copied().collect::<BTreeSet<_>>().len(), 3);
        assert!(labels[..6].iter().all(|label| *label == labels[0]));
        assert!(labels[6..12].iter().all(|label| *label == labels[6]));
        assert_ne!(labels[0], labels[6]);
        assert_ne!(labels[0], labels[12]);
        assert_ne!(labels[6], labels[12]);
    }

    #[test]
    fn drops_overlap_only_speakers_and_compacts_terminal_labels() {
        let config = BoundedDiarizationConfig {
            window_samples: 1_000,
            overlap_samples: 100,
            ..BoundedDiarizationConfig::default()
        };
        let plan = bounded_window_plan(1_900, config).unwrap();
        let observations = vec![
            WindowObservation {
                window: plan[0],
                speakers: vec![LocalSpeakerObservation {
                    local_speaker: 0,
                    embedding: embedding(0, 0.0),
                    segments: vec![LocalSegment {
                        start_sample: 0,
                        end_sample: 900,
                    }],
                }],
            },
            WindowObservation {
                window: plan[1],
                speakers: vec![LocalSpeakerObservation {
                    local_speaker: 7,
                    embedding: embedding(1, 0.0),
                    segments: vec![LocalSegment {
                        start_sample: 0,
                        end_sample: 40,
                    }],
                }],
            },
        ];
        let projection =
            consolidate_diarization(1_900, &observations, config, test_cluster, || {}).unwrap();
        assert_eq!(projection.speaker_count, 1);
        assert_eq!(projection.assignments.len(), 1);
        assert_eq!(projection.assignments[0].window_index, 0);
        assert_eq!(projection.assignments[0].global_speaker, 0);
        assert!(
            projection
                .segments
                .iter()
                .all(|segment| segment.global_speaker == 0)
        );
    }

    #[test]
    fn overlap_midpoint_has_single_owner_and_full_terminal_coverage() {
        let config = BoundedDiarizationConfig {
            window_samples: 1_000,
            overlap_samples: 100,
            ..BoundedDiarizationConfig::default()
        };
        let plan = bounded_window_plan(1_900, config).unwrap();
        assert_eq!(plan.len(), 2, "fully covered duration has no tail window");
        let projection = consolidate_diarization(
            1_900,
            &observation_for_plan(&plan, 1),
            config,
            test_cluster,
            || {},
        )
        .unwrap();
        assert_eq!(
            projection.segments,
            vec![GlobalSpeakerSegment {
                start_sample: 0,
                end_sample: 1_900,
                global_speaker: 0,
            }]
        );
    }

    #[test]
    fn rejects_unbounded_or_non_finite_model_output() {
        let config = BoundedDiarizationConfig {
            window_samples: 1_000,
            overlap_samples: 100,
            ..BoundedDiarizationConfig::default()
        };
        let plan = bounded_window_plan(1_000, config).unwrap();
        let invalid_values = [
            vec![0.0; SPEAKER_EMBEDDING_DIMENSION],
            vec![f32::NAN; SPEAKER_EMBEDDING_DIMENSION],
            vec![1.0; SPEAKER_EMBEDDING_DIMENSION - 1],
        ];
        for embedding in invalid_values {
            let observations = vec![WindowObservation {
                window: plan[0],
                speakers: vec![LocalSpeakerObservation {
                    local_speaker: 0,
                    embedding,
                    segments: vec![LocalSegment {
                        start_sample: 0,
                        end_sample: 1_000,
                    }],
                }],
            }];
            assert_eq!(
                consolidate_diarization(1_000, &observations, config, test_cluster, || {}),
                Err(DiarizationError::InvalidEmbedding)
            );
        }

        let too_many_speakers = (0..=MAX_LOCAL_SPEAKERS_PER_WINDOW)
            .map(|speaker| LocalSpeakerObservation {
                local_speaker: speaker as u32,
                embedding: embedding(speaker % 8, 0.0),
                segments: Vec::new(),
            })
            .collect();
        assert_eq!(
            consolidate_diarization(
                1_000,
                &[WindowObservation {
                    window: plan[0],
                    speakers: too_many_speakers,
                }],
                config,
                test_cluster,
                || {},
            ),
            Err(DiarizationError::ResourceLimit)
        );
    }

    #[test]
    fn consolidation_is_deterministic_and_accepts_empty_model_windows() {
        let config = BoundedDiarizationConfig {
            window_samples: 1_000,
            overlap_samples: 100,
            ..BoundedDiarizationConfig::default()
        };
        let plan = bounded_window_plan(1_900, config).unwrap();
        let observations = plan
            .iter()
            .map(|&window| WindowObservation {
                window,
                speakers: Vec::new(),
            })
            .collect::<Vec<_>>();
        let first =
            consolidate_diarization(1_900, &observations, config, test_cluster, || {}).unwrap();
        let second =
            consolidate_diarization(1_900, &observations, config, test_cluster, || {}).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.speaker_count, 0);
        assert!(first.assignments.is_empty());
        assert!(first.segments.is_empty());
    }
}
