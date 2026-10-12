export { VERSION_TABLE } from './version.js';
export { negotiateVersion } from './negotiate-version.js';
export type { VersionRange } from './negotiate-version.js';
export {
  AgentId,
  DeviceId,
  EnvelopeId,
  EpochMs,
  OpaqueId,
  RequestId,
  SessionId,
  Sha256Hex,
} from './ids.js';

export { Envelope, MAX_PAYLOAD_LENGTH } from './envelope.js';
export {
  Ack,
  Hello,
  HelloOk,
  Ping,
  Pong,
  Presence,
  PresenceEntry,
  RelayError,
  RelayErrorCode,
} from './control-frames.js';
export { Frame, FRAME_KINDS } from './frame.js';
export { parseFrame } from './parse-frame.js';
export type { FrameError, ParseFrameResult } from './parse-frame.js';
export { encodeFrame } from './encode-frame.js';

export { Capabilities } from './domain/capabilities.js';
export { Machine } from './domain/machine.js';
export { Repository } from './domain/repository.js';
export { ChangedFile, Session } from './domain/session.js';
export { ApprovalRequest } from './domain/approval-request.js';
export { Question, QuestionOption } from './domain/question.js';
export { Decision } from './domain/decision.js';
export { Instruction } from './domain/instruction.js';
export { StartSession } from './domain/start-session.js';

export { RequestEvent, RequestState, REQUEST_TRANSITIONS } from './request-lifecycle.js';
export { transitionRequest } from './transition-request.js';
export type { RequestTransition } from './transition-request.js';

export { canonicalJson } from './canonical-json.js';
export { toBase64Url, toHex } from './encoding.js';
export { CanonicalDecision, DECISION_TTL_SECONDS, DecisionKind } from './canonical-decision.js';
export { requiresAssertion } from './requires-assertion.js';
export { decisionHash } from './decision-hash.js';
export { decisionChallenge } from './decision-challenge.js';
export { requestHash } from './request-hash.js';
export type { RequestHashInput } from './request-hash.js';

export type { Clock } from './ports/clock.js';
export type { Random } from './ports/random.js';
