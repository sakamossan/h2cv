export type SendTimings = {
  pollIntervalMs: number;
  boxReadyTimeoutMs: number;
  landingTimeoutMs: number;
  slashSubmitFloorMs: number;
  exitDialogGoneTimeoutMs: number;
};
export type GateTimings = {
  inputReadyPollMs: number;
  inputReadyTimeoutMs: number;
  idleProbeSliceMs: number;
  rcConnectTimeoutMs: number;
  interstitialSettleMs: number;
};
export type LaunchTimings = {
  readinessPanePollMs: number;
  shellReadyTimeoutMs: number;
  shellProbeWaitMs: number;
};
export type SessionTimings = SendTimings & GateTimings & LaunchTimings;
export const DEFAULT_SESSION_TIMINGS: SessionTimings = {
  pollIntervalMs: 50,
  boxReadyTimeoutMs: 1500,
  landingTimeoutMs: 1500,
  slashSubmitFloorMs: 200,
  exitDialogGoneTimeoutMs: 30000,
  inputReadyPollMs: 250,
  inputReadyTimeoutMs: 300000,
  idleProbeSliceMs: 5000,
  rcConnectTimeoutMs: 30000,
  interstitialSettleMs: 1000,
  readinessPanePollMs: 1000,
  shellReadyTimeoutMs: 30000,
  shellProbeWaitMs: 2000,
};
