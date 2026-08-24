use std::collections::{BTreeMap, HashMap};

pub const SPEAKER_EMBEDDING_DIMENSION: usize = 512;
pub const DEFAULT_SAMPLE_RATE: u32 = 16_000;
pub const DEFAULT_WINDOW_SAMPLES: u64 = 5 * 60 * DEFAULT_SAMPLE_RATE as u64;
pub const DEFAULT_OVERLAP_SAMPLES: u64 = 10 * DEFAULT_SAMPLE_RATE as u64;

const MAX_WINDOWS: usize = 512;
const MAX_LOCAL_SPEAKERS_PER_WINDOW: usize = 32;
const MAX_SEGMENTS_PER_WINDOW: usize = 16_384;
const MAX_GLOBAL_PROTOTYPES: usize = 2_048;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BoundedDiarizationConfig {
    pub window_samples: u64,
    pub overlap_samples: u64,
    pub window_merge_distance: f32,
    pub global_cluster_distance: f32,
    pub global_min_samples: usize,
}

impl Default for BoundedDiarizationConfig {
    fn default() -> Self {
        Self {
            window_samples: DEFAULT_WINDOW_SAMPLES,
            overlap_samples: DEFAULT_OVERLAP_SAMPLES,
            window_merge_distance: 0.75,
            global_cluster_distance: 0.50,
            global_min_samples: 3,
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
pub fn consolidate_diarization(
    total_samples: u64,
    observations: &[WindowObservation],
    config: BoundedDiarizationConfig,
) -> Result<DiarizationProjection, DiarizationError> {
    let planned = bounded_window_plan(total_samples, config)?;
    if observations.len() != planned.len()
        || observations
            .iter()
            .zip(&planned)
            .any(|(actual, expected)| actual.window != *expected)
    {
        return Err(DiarizationError::WindowPlanMismatch);
    }

    let mut prototypes = Vec::new();
    let mut identities = Vec::new();
    let mut window_local_to_prototype = HashMap::new();
    let mut total_segments = 0_usize;

    for observation in observations {
        if observation.speakers.len() > MAX_LOCAL_SPEAKERS_PER_WINDOW {
            return Err(DiarizationError::ResourceLimit);
        }
        let window_length = observation.window.end_sample - observation.window.start_sample;
        let mut local_ids = BTreeMap::new();
        let mut embeddings = Vec::with_capacity(observation.speakers.len());
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

        let window_prototypes = complete_link_prototypes(&embeddings, config.window_merge_distance);
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

    let global_labels = density_cluster(
        &prototypes,
        config.global_cluster_distance,
        config.global_min_samples,
    );
    let speaker_count = global_labels
        .iter()
        .copied()
        .max()
        .map_or(0, |label| label + 1);

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

    Ok(DiarizationProjection {
        speaker_count,
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
        || !valid_distance(config.global_cluster_distance)
        || config.global_min_samples == 0
        || config.global_min_samples > MAX_GLOBAL_PROTOTYPES
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

fn complete_link_prototypes(embeddings: &[Vec<f32>], threshold: f32) -> Vec<WindowPrototype> {
    let mut clusters = embeddings
        .iter()
        .enumerate()
        .map(|(index, embedding)| WindowPrototype {
            embedding: embedding.clone(),
            members: vec![index],
        })
        .collect::<Vec<_>>();

    loop {
        let mut closest = None;
        for left in 0..clusters.len() {
            for right in (left + 1)..clusters.len() {
                let distance = complete_link_distance(
                    &clusters[left].members,
                    &clusters[right].members,
                    embeddings,
                );
                if distance <= threshold
                    && closest.is_none_or(|(_, _, closest_distance)| distance < closest_distance)
                {
                    closest = Some((left, right, distance));
                }
            }
        }
        let Some((left, right, _)) = closest else {
            break;
        };
        let right_cluster = clusters.remove(right);
        clusters[left].members.extend(right_cluster.members);
        clusters[left].members.sort_unstable();
        clusters[left].embedding = normalized_centroid(&clusters[left].members, embeddings);
    }
    clusters
}

fn complete_link_distance(left: &[usize], right: &[usize], embeddings: &[Vec<f32>]) -> f32 {
    left.iter()
        .flat_map(|&left_index| {
            right.iter().map(move |&right_index| {
                cosine_distance(&embeddings[left_index], &embeddings[right_index])
            })
        })
        .fold(0.0_f32, f32::max)
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

fn density_cluster(embeddings: &[Vec<f32>], threshold: f32, min_samples: usize) -> Vec<u32> {
    if embeddings.is_empty() {
        return Vec::new();
    }
    let row_count = embeddings.len();
    let mut distances = vec![0.0_f32; row_count * row_count];
    let mut neighbor_counts = vec![1_usize; row_count];
    for left in 0..row_count {
        for right in (left + 1)..row_count {
            let distance = cosine_distance(&embeddings[left], &embeddings[right]);
            distances[left * row_count + right] = distance;
            distances[right * row_count + left] = distance;
            if distance <= threshold {
                neighbor_counts[left] += 1;
                neighbor_counts[right] += 1;
            }
        }
    }

    let mut components = UnionFind::new(row_count);
    for left in 0..row_count {
        if neighbor_counts[left] < min_samples {
            continue;
        }
        for right in (left + 1)..row_count {
            if neighbor_counts[right] >= min_samples
                && distances[left * row_count + right] <= threshold
            {
                components.unite(left, right);
            }
        }
    }

    let mut assignments = vec![usize::MAX; row_count];
    for row in 0..row_count {
        if neighbor_counts[row] >= min_samples {
            assignments[row] = components.find(row);
            continue;
        }
        let mut best = None;
        for candidate in 0..row_count {
            if neighbor_counts[candidate] < min_samples {
                continue;
            }
            let distance = distances[row * row_count + candidate];
            if distance <= threshold
                && best.is_none_or(|(_, best_distance)| distance < best_distance)
            {
                best = Some((candidate, distance));
            }
        }
        assignments[row] = best.map_or(row, |(candidate, _)| components.find(candidate));
    }

    let mut compact = HashMap::new();
    assignments
        .into_iter()
        .map(|assignment| {
            let next = compact.len() as u32;
            *compact.entry(assignment).or_insert(next)
        })
        .collect()
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

#[derive(Debug)]
struct UnionFind {
    parent: Vec<usize>,
    rank: Vec<u8>,
}

impl UnionFind {
    fn new(size: usize) -> Self {
        Self {
            parent: (0..size).collect(),
            rank: vec![0; size],
        }
    }

    fn find(&mut self, value: usize) -> usize {
        if self.parent[value] != value {
            self.parent[value] = self.find(self.parent[value]);
        }
        self.parent[value]
    }

    fn unite(&mut self, left: usize, right: usize) {
        let mut left = self.find(left);
        let mut right = self.find(right);
        if left == right {
            return;
        }
        if self.rank[left] < self.rank[right] {
            std::mem::swap(&mut left, &mut right);
        }
        self.parent[right] = left;
        if self.rank[left] == self.rank[right] {
            self.rank[left] += 1;
        }
    }
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

    #[test]
    fn frozen_short_corpora_keep_record_wide_speaker_identity() {
        let config = BoundedDiarizationConfig {
            window_samples: 1_000,
            overlap_samples: 100,
            ..BoundedDiarizationConfig::default()
        };
        let plan = bounded_window_plan(5_000, config).unwrap();
        for expected in [4, 2, 2, 2] {
            let projection =
                consolidate_diarization(5_000, &observation_for_plan(&plan, expected), config)
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
        let projection = consolidate_diarization(50_000, &observations, config).unwrap();
        assert_eq!(projection.speaker_count, 1);
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
        let projection = consolidate_diarization(1_000, &observations, config).unwrap();
        assert_eq!(projection.speaker_count, 1);
        assert_eq!(projection.assignments.len(), 2);
        assert_eq!(
            projection.assignments[0].global_speaker,
            projection.assignments[1].global_speaker
        );
    }

    #[test]
    fn non_core_bridge_cannot_join_two_dense_speaker_components() {
        let point = |degrees: f32| {
            let radians = degrees.to_radians();
            let mut values = vec![0.0; SPEAKER_EMBEDDING_DIMENSION];
            values[0] = radians.cos();
            values[1] = radians.sin();
            values
        };
        let points = [-20.0, -10.0, 0.0, 10.0, 70.0, 80.0, 90.0, 100.0, 40.0]
            .into_iter()
            .map(point)
            .collect::<Vec<_>>();

        let labels = density_cluster(&points, 0.1341, 4);
        assert!(labels[..4].iter().all(|label| *label == labels[0]));
        assert!(labels[4..8].iter().all(|label| *label == labels[4]));
        assert_ne!(labels[0], labels[4]);
    }

    #[test]
    fn overlap_midpoint_has_single_owner_and_full_terminal_coverage() {
        let config = BoundedDiarizationConfig {
            window_samples: 1_000,
            overlap_samples: 100,
            global_min_samples: 2,
            ..BoundedDiarizationConfig::default()
        };
        let plan = bounded_window_plan(1_900, config).unwrap();
        assert_eq!(plan.len(), 2, "fully covered duration has no tail window");
        let projection =
            consolidate_diarization(1_900, &observation_for_plan(&plan, 1), config).unwrap();
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
                consolidate_diarization(1_000, &observations, config),
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
        let first = consolidate_diarization(1_900, &observations, config).unwrap();
        let second = consolidate_diarization(1_900, &observations, config).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.speaker_count, 0);
        assert!(first.assignments.is_empty());
        assert!(first.segments.is_empty());
    }
}
