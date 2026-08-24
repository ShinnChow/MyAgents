//! Platform capture adapters behind one RecordingManager-owned contract.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, SupportedStreamConfig};
use serde::{Deserialize, Serialize};
use std::any::Any;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

use super::audio::{RealtimeTrackSink, SourceFormat};
use crate::record::AudioTrackKind;
#[cfg(target_os = "linux")]
use crate::ulog_warn;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSelection {
    pub microphone: bool,
    pub system: bool,
}

impl Default for CaptureSelection {
    fn default() -> Self {
        Self {
            microphone: true,
            system: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedSource {
    pub track: AudioTrackKind,
    pub label: String,
    pub format: CaptureFormat,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureFormat {
    pub sample_rate: u32,
    pub channels: u16,
}

impl From<SourceFormat> for CaptureFormat {
    fn from(value: SourceFormat) -> Self {
        Self {
            sample_rate: value.sample_rate,
            channels: value.channels,
        }
    }
}

impl From<CaptureFormat> for SourceFormat {
    fn from(value: CaptureFormat) -> Self {
        Self {
            sample_rate: value.sample_rate,
            channels: value.channels,
        }
    }
}

pub struct CapturePlan {
    pub sources: Vec<PreparedSource>,
    token: Arc<dyn Any + Send + Sync>,
}

impl std::fmt::Debug for CapturePlan {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CapturePlan")
            .field("sources", &self.sources)
            .finish_non_exhaustive()
    }
}

impl CapturePlan {
    #[cfg(test)]
    pub fn for_test(sources: Vec<PreparedSource>) -> Self {
        Self {
            sources,
            token: Arc::new(()),
        }
    }
}

#[derive(Debug, Clone)]
pub enum CaptureEvent {
    DeviceGap { track: AudioTrackKind, code: String },
    Fatal { track: AudioTrackKind, code: String },
}

pub struct CaptureSinks {
    pub microphone: Option<CaptureTrackSink>,
    pub system: Option<CaptureTrackSink>,
}

/// The capture callback has one bounded fan-out point. Archive delivery is
/// always attempted first because the durable recording remains authoritative;
/// live analysis may fail independently without degrading the archive.
#[derive(Clone)]
pub struct CaptureTrackSink {
    archive: RealtimeTrackSink,
    analysis: Option<RealtimeTrackSink>,
}

impl CaptureTrackSink {
    pub fn new(archive: RealtimeTrackSink, analysis: Option<RealtimeTrackSink>) -> Self {
        Self { archive, analysis }
    }

    pub(crate) fn push_f32(&self, samples: &[f32]) {
        self.archive.push_f32(samples);
        if let Some(analysis) = self.analysis.as_ref() {
            analysis.push_f32(samples);
        }
    }

    fn push_i16(&self, samples: &[i16]) {
        self.archive.push_i16(samples);
        if let Some(analysis) = self.analysis.as_ref() {
            analysis.push_i16(samples);
        }
    }

    fn push_i32(&self, samples: &[i32]) {
        self.archive.push_i32(samples);
        if let Some(analysis) = self.analysis.as_ref() {
            analysis.push_i32(samples);
        }
    }

    fn push_i8(&self, samples: &[i8]) {
        self.archive.push_i8(samples);
        if let Some(analysis) = self.analysis.as_ref() {
            analysis.push_i8(samples);
        }
    }

    fn push_planar_f32(&self, planes: &[&[f32]]) {
        self.archive.push_planar_f32(planes);
        if let Some(analysis) = self.analysis.as_ref() {
            analysis.push_planar_f32(planes);
        }
    }
}

pub trait CaptureSession: Send {
    fn pause(&mut self) -> Result<(), String>;
    fn resume(&mut self) -> Result<(), String>;
    fn stop(&mut self) -> Result<(), String>;
}

pub trait CaptureBackend: Send + Sync {
    fn preflight(&self, selection: CaptureSelection) -> Result<CapturePlan, String>;
    fn open(
        &self,
        plan: &CapturePlan,
        sinks: CaptureSinks,
        events: mpsc::UnboundedSender<CaptureEvent>,
    ) -> Result<Box<dyn CaptureSession>, String>;
}

#[derive(Default)]
pub struct PlatformCaptureBackend;

#[derive(Clone)]
struct PlatformPlan {
    microphone: Option<CpalEndpoint>,
    #[cfg(not(target_os = "macos"))]
    system: Option<CpalEndpoint>,
    #[cfg(target_os = "macos")]
    system_display_id: Option<u32>,
}

#[derive(Clone)]
struct CpalEndpoint {
    device_id: String,
    config: SupportedStreamConfig,
    track: AudioTrackKind,
}

impl CaptureBackend for PlatformCaptureBackend {
    fn preflight(&self, selection: CaptureSelection) -> Result<CapturePlan, String> {
        if !selection.microphone && !selection.system {
            return Err("at least one recording source must be selected".to_string());
        }
        let host = capture_host()?;
        let microphone = if selection.microphone {
            let device = host
                .default_input_device()
                .ok_or_else(|| "RECORDING_MICROPHONE_UNAVAILABLE".to_string())?;
            Some(cpal_endpoint(&device, AudioTrackKind::Microphone, false)?)
        } else {
            None
        };

        #[cfg(target_os = "macos")]
        let (system_display_id, system_source) = if selection.system {
            use screencapturekit::prelude::SCShareableContent;
            let content = SCShareableContent::get()
                .map_err(|error| format!("RECORDING_SCREEN_PERMISSION_REQUIRED: {error}"))?;
            let display = content
                .displays()
                .into_iter()
                .next()
                .ok_or_else(|| "RECORDING_SYSTEM_AUDIO_UNAVAILABLE".to_string())?;
            (
                Some(display.display_id()),
                Some(PreparedSource {
                    track: AudioTrackKind::System,
                    label: "macOS system audio".to_string(),
                    format: CaptureFormat {
                        sample_rate: 48_000,
                        channels: 2,
                    },
                }),
            )
        } else {
            (None, None)
        };

        #[cfg(all(not(target_os = "macos"), not(target_os = "linux")))]
        let (system, system_source) = if selection.system {
            let device = system_capture_device(&host)?;
            let endpoint = cpal_endpoint(&device, AudioTrackKind::System, true)?;
            let source = prepared_source(&device, &endpoint)?;
            (Some(endpoint), Some(source))
        } else {
            (None, None)
        };

        #[cfg(target_os = "linux")]
        let (system, system_source) = if selection.system {
            match system_capture_device(&host).and_then(|device| {
                let endpoint = cpal_endpoint(&device, AudioTrackKind::System, true)?;
                let source = prepared_source(&device, &endpoint)?;
                Ok((endpoint, source))
            }) {
                Ok((endpoint, source)) => (Some(endpoint), Some(source)),
                Err(error) => {
                    ulog_warn!(
                        "[recording] PipeWire system audio unavailable; continuing microphone-only: {}",
                        error
                    );
                    (None, None)
                }
            }
        } else {
            (None, None)
        };

        let mut sources = Vec::new();
        if let Some(endpoint) = microphone.as_ref() {
            let device = resolve_device(&host, &endpoint.device_id)?;
            sources.push(prepared_source(&device, endpoint)?);
        }
        if let Some(source) = system_source {
            sources.push(source);
        }
        if sources.is_empty() {
            return Err("RECORDING_NO_AVAILABLE_SOURCE".to_string());
        }
        Ok(CapturePlan {
            sources,
            token: Arc::new(PlatformPlan {
                microphone,
                #[cfg(not(target_os = "macos"))]
                system,
                #[cfg(target_os = "macos")]
                system_display_id,
            }),
        })
    }

    fn open(
        &self,
        plan: &CapturePlan,
        sinks: CaptureSinks,
        events: mpsc::UnboundedSender<CaptureEvent>,
    ) -> Result<Box<dyn CaptureSession>, String> {
        let token = plan
            .token
            .downcast_ref::<PlatformPlan>()
            .ok_or_else(|| "capture plan/backend mismatch".to_string())?;
        let host = capture_host()?;
        let mut streams = Vec::new();
        if let Some(endpoint) = token.microphone.as_ref() {
            let sink = sinks
                .microphone
                .ok_or_else(|| "microphone archive sink missing".to_string())?;
            streams.push(open_cpal_stream(&host, endpoint, sink, events.clone())?);
        }

        #[cfg(not(target_os = "macos"))]
        if let Some(endpoint) = token.system.as_ref() {
            let sink = sinks
                .system
                .ok_or_else(|| "system archive sink missing".to_string())?;
            streams.push(open_cpal_stream(&host, endpoint, sink, events.clone())?);
        }

        #[cfg(target_os = "macos")]
        let screen_stream = if let Some(display_id) = token.system_display_id {
            let sink = sinks
                .system
                .ok_or_else(|| "system archive sink missing".to_string())?;
            Some(open_macos_system_stream(display_id, sink, events.clone())?)
        } else {
            None
        };

        for stream in &streams {
            stream
                .play()
                .map_err(|error| format!("start capture stream: {error}"))?;
        }
        #[cfg(target_os = "macos")]
        if let Some(stream) = screen_stream.as_ref() {
            stream
                .start_capture()
                .map_err(|error| format!("start system audio capture: {error}"))?;
        }
        Ok(Box::new(PlatformCaptureSession {
            streams,
            #[cfg(target_os = "macos")]
            screen_stream,
            stopped: false,
        }))
    }
}

struct PlatformCaptureSession {
    streams: Vec<cpal::Stream>,
    #[cfg(target_os = "macos")]
    screen_stream: Option<screencapturekit::stream::SCStream>,
    stopped: bool,
}

impl CaptureSession for PlatformCaptureSession {
    fn pause(&mut self) -> Result<(), String> {
        if self.stopped {
            return Ok(());
        }
        for stream in &self.streams {
            stream
                .pause()
                .map_err(|error| format!("pause capture stream: {error}"))?;
        }
        #[cfg(target_os = "macos")]
        if let Some(stream) = self.screen_stream.as_ref() {
            stream
                .stop_capture()
                .map_err(|error| format!("pause system audio capture: {error}"))?;
        }
        Ok(())
    }

    fn resume(&mut self) -> Result<(), String> {
        if self.stopped {
            return Err("capture session already stopped".to_string());
        }
        for stream in &self.streams {
            stream
                .play()
                .map_err(|error| format!("resume capture stream: {error}"))?;
        }
        #[cfg(target_os = "macos")]
        if let Some(stream) = self.screen_stream.as_ref() {
            stream
                .start_capture()
                .map_err(|error| format!("resume system audio capture: {error}"))?;
        }
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        if self.stopped {
            return Ok(());
        }
        self.stopped = true;
        let mut failures = Vec::new();
        for stream in &self.streams {
            if let Err(error) = stream.pause() {
                failures.push(format!("stop capture stream: {error}"));
            }
        }
        #[cfg(target_os = "macos")]
        if let Some(stream) = self.screen_stream.as_ref() {
            if let Err(error) = stream.stop_capture() {
                failures.push(format!("stop system audio capture: {error}"));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }
}

fn capture_host() -> Result<cpal::Host, String> {
    #[cfg(target_os = "linux")]
    {
        cpal::host_from_id(cpal::HostId::PipeWire)
            .map_err(|error| format!("RECORDING_PIPEWIRE_UNAVAILABLE: {error}"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(cpal::default_host())
    }
}

#[cfg(not(target_os = "macos"))]
fn system_capture_device(host: &cpal::Host) -> Result<Device, String> {
    #[cfg(target_os = "windows")]
    {
        host.default_output_device()
            .ok_or_else(|| "RECORDING_SYSTEM_AUDIO_UNAVAILABLE".to_string())
    }
    #[cfg(target_os = "linux")]
    {
        host.devices()
            .map_err(|error| format!("probe PipeWire nodes: {error}"))?
            .find(|device| {
                device.description().is_ok_and(|description| {
                    description.name() == "default_sink" && description.supports_input()
                })
            })
            .ok_or_else(|| "RECORDING_PIPEWIRE_MONITOR_UNAVAILABLE".to_string())
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = host;
        Err("RECORDING_SYSTEM_AUDIO_UNAVAILABLE".to_string())
    }
}

fn cpal_endpoint(
    device: &Device,
    track: AudioTrackKind,
    loopback: bool,
) -> Result<CpalEndpoint, String> {
    let config = if loopback && cfg!(target_os = "windows") {
        device.default_output_config()
    } else {
        device.default_input_config()
    }
    .map_err(|error| format!("probe {track:?} capture format: {error}"))?;
    if !matches!(
        config.sample_format(),
        SampleFormat::I8 | SampleFormat::I16 | SampleFormat::I32 | SampleFormat::F32
    ) {
        return Err(format!(
            "unsupported {track:?} capture sample format: {}",
            config.sample_format()
        ));
    }
    Ok(CpalEndpoint {
        device_id: device
            .id()
            .map_err(|error| format!("read capture device identity: {error}"))?
            .to_string(),
        config,
        track,
    })
}

fn prepared_source(device: &Device, endpoint: &CpalEndpoint) -> Result<PreparedSource, String> {
    Ok(PreparedSource {
        track: endpoint.track,
        label: device
            .description()
            .map_err(|error| format!("read capture device description: {error}"))?
            .name()
            .to_string(),
        format: CaptureFormat {
            sample_rate: endpoint.config.sample_rate(),
            channels: endpoint.config.channels(),
        },
    })
}

fn resolve_device(host: &cpal::Host, id: &str) -> Result<Device, String> {
    let id = id
        .parse()
        .map_err(|error| format!("parse capture device identity: {error}"))?;
    host.device_by_id(&id)
        .ok_or_else(|| "RECORDING_DEVICE_CHANGED".to_string())
}

fn open_cpal_stream(
    host: &cpal::Host,
    endpoint: &CpalEndpoint,
    sink: CaptureTrackSink,
    events: mpsc::UnboundedSender<CaptureEvent>,
) -> Result<cpal::Stream, String> {
    let device = resolve_device(host, &endpoint.device_id)?;
    let config = endpoint.config.into();
    let track = endpoint.track;
    let error_events = events.clone();
    let error_callback = move |error: cpal::Error| {
        let code = format!("CPAL_{:?}", error.kind()).to_ascii_uppercase();
        let event = match error.kind() {
            // CPAL streams recover from bounded XRuns in place; keep the
            // explicit gap in lifecycle without tearing down a healthy stream.
            cpal::ErrorKind::Xrun => CaptureEvent::DeviceGap { track, code },
            // This backend freezes exact device identity at admission and has
            // no truthful way to hot-adopt a replacement device.
            cpal::ErrorKind::DeviceChanged => CaptureEvent::Fatal { track, code },
            _ => CaptureEvent::Fatal { track, code },
        };
        let _ = error_events.send(event);
    };
    match endpoint.config.sample_format() {
        SampleFormat::F32 => device.build_input_stream(
            config,
            move |data: &[f32], _| sink.push_f32(data),
            error_callback,
            None,
        ),
        SampleFormat::I16 => device.build_input_stream(
            config,
            move |data: &[i16], _| sink.push_i16(data),
            error_callback,
            None,
        ),
        SampleFormat::I32 => device.build_input_stream(
            config,
            move |data: &[i32], _| sink.push_i32(data),
            error_callback,
            None,
        ),
        SampleFormat::I8 => device.build_input_stream(
            config,
            move |data: &[i8], _| sink.push_i8(data),
            error_callback,
            None,
        ),
        _ => return Err("unsupported capture sample format".to_string()),
    }
    .map_err(|error| format!("open {track:?} capture stream: {error}"))
}

#[cfg(target_os = "macos")]
fn open_macos_system_stream(
    display_id: u32,
    sink: CaptureTrackSink,
    events: mpsc::UnboundedSender<CaptureEvent>,
) -> Result<screencapturekit::stream::SCStream, String> {
    use screencapturekit::prelude::*;

    struct Delegate {
        events: mpsc::UnboundedSender<CaptureEvent>,
    }
    impl SCStreamDelegateTrait for Delegate {
        fn did_stop_with_error(&self, error: SCError) {
            let _ = self.events.send(CaptureEvent::Fatal {
                track: AudioTrackKind::System,
                code: format!("SCREEN_CAPTURE_KIT_{error}"),
            });
        }
    }

    let content =
        SCShareableContent::get().map_err(|error| format!("refresh shareable content: {error}"))?;
    let display = content
        .displays()
        .into_iter()
        .find(|display| display.display_id() == display_id)
        .ok_or_else(|| "RECORDING_DISPLAY_CHANGED".to_string())?;
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build();
    let frame_interval = CMTime::new(1, 1);
    let config = SCStreamConfiguration::new()
        .with_width(2)
        .with_height(2)
        .with_minimum_frame_interval(&frame_interval)
        .with_captures_audio(true)
        .with_excludes_current_process_audio(true)
        .with_sample_rate(48_000)
        .with_channel_count(2);
    let mut stream = SCStream::new_with_delegate(
        &filter,
        &config,
        Delegate {
            events: events.clone(),
        },
    );
    let malformed_reported = Arc::new(AtomicBool::new(false));
    stream.add_output_handler(
        move |sample: CMSampleBuffer, output_type: SCStreamOutputType| {
            if output_type != SCStreamOutputType::Audio {
                return;
            }
            let valid_format = sample.format_description().is_some_and(|format| {
                format.audio_is_float()
                    && !format.audio_is_big_endian()
                    && format.audio_bits_per_channel() == Some(32)
                    && format.audio_channel_count() == Some(2)
                    && format.audio_sample_rate() == Some(48_000.0)
            });
            let Some(buffers) = sample.audio_buffer_list() else {
                report_malformed_sck(&events, &malformed_reported);
                return;
            };
            if !valid_format {
                report_malformed_sck(&events, &malformed_reported);
                return;
            }
            match buffers.num_buffers() {
                1 => {
                    let Some(buffer) = buffers.get(0) else {
                        return;
                    };
                    let bytes = buffer.data();
                    let (prefix, samples, suffix) = unsafe { bytes.align_to::<f32>() };
                    if prefix.is_empty() && suffix.is_empty() && buffer.number_channels == 2 {
                        sink.push_f32(samples);
                    } else {
                        report_malformed_sck(&events, &malformed_reported);
                    }
                }
                2 => {
                    let (Some(left), Some(right)) = (buffers.get(0), buffers.get(1)) else {
                        return;
                    };
                    let (left_prefix, left_samples, left_suffix) =
                        unsafe { left.data().align_to::<f32>() };
                    let (right_prefix, right_samples, right_suffix) =
                        unsafe { right.data().align_to::<f32>() };
                    if left_prefix.is_empty()
                        && left_suffix.is_empty()
                        && right_prefix.is_empty()
                        && right_suffix.is_empty()
                        && left.number_channels == 1
                        && right.number_channels == 1
                    {
                        sink.push_planar_f32(&[left_samples, right_samples]);
                    } else {
                        report_malformed_sck(&events, &malformed_reported);
                    }
                }
                _ => report_malformed_sck(&events, &malformed_reported),
            }
        },
        SCStreamOutputType::Audio,
    );
    Ok(stream)
}

#[cfg(target_os = "macos")]
fn report_malformed_sck(events: &mpsc::UnboundedSender<CaptureEvent>, reported: &AtomicBool) {
    if !reported.swap(true, Ordering::AcqRel) {
        let _ = events.send(CaptureEvent::Fatal {
            track: AudioTrackKind::System,
            code: "SCREEN_CAPTURE_KIT_UNEXPECTED_AUDIO_FORMAT".to_string(),
        });
    }
}
