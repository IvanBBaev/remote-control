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

export { Envelope, MAX_PAYLOAD_LENGTH, MAX_PUSH_BLOB_LENGTH } from './envelope.js';
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
export { AlwaysDestination } from './domain/always-destination.js';
export { ApprovalRequest } from './domain/approval-request.js';
export {
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  Question,
  QuestionItem,
  QuestionOption,
} from './domain/question.js';
export {
  AnswerPayload,
  MAX_OTHER_LENGTH,
  MAX_RESPONSE_LENGTH,
  QuestionAnswer,
  encodeAnswerPayload,
  parseAnswerPayload,
} from './answer-payload.js';
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
export { requestHash, requestHashSubject } from './request-hash.js';
export type { RequestHashInput } from './request-hash.js';
export {
  CLAUDE_CODE_TOOL_NAMES,
  CLAUDE_CODE_TOOLS,
  MAX_TOOL_LABEL_LENGTH,
  mcpToolName,
  toolInfo,
  toolLabel,
  unknownToolLabel,
} from './tool-labels.js';
export type { ClaudeCodeTool, ToolInfo, ToolKind } from './tool-labels.js';
export {
  decodePushSummary,
  encodePushSummary,
  MAX_PUSH_SUMMARY_JSON_BYTES,
  PushSummary,
} from './push-summary.js';

export type { Clock } from './ports/clock.js';
export type { Random } from './ports/random.js';

export {
  AgentMessage,
  DecisionMessage,
  DecisionRejection,
  DecisionResultMessage,
  EventMessage,
  ExpiredMessage,
  HANDSHAKE_TAG,
  HistoryMessage,
  InstructMessage,
  MAX_HISTORY_PROJECTS,
  PairingHello,
  PhoneMessage,
  ProjectHistory,
  QuestionMessage,
  RequestMessage,
  ResolvedMessage,
  SnapshotMessage,
  StartMessage,
} from './messages.js';
export {
  applyFeedEvent,
  clip,
  EMPTY_CONTENT,
  FeedEvent,
  fitSnapshot,
  MAX_CHANGED_FILES,
  MAX_FEED_TEXT_LENGTH,
  MAX_MESSAGE_BYTES,
  MAX_SESSION_STEPS,
  MAX_STEP_LENGTH,
  MAX_TOOL_DETAIL_LENGTH,
  messageBytes,
  toolStep,
} from './session-feed.js';
export type { SessionContent } from './session-feed.js';
