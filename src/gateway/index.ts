// Public surface of the model gateway. The main process imports from here.

export { ModelGateway } from "./gateway.js";
export type { ModelGatewayOptions } from "./gateway.js";

export { GatewayError } from "./errors.js";
export type { GatewayErrorOptions } from "./errors.js";

export { KeyStore } from "./keyStore.js";
export type { KeyStoreOptions } from "./keyStore.js";

export { InMemoryKeychain } from "./keychain.js";
export type { KeychainAdapter } from "./keychain.js";

export {
  scrub,
  toSafeError,
  createScrubbingLogger,
} from "./redaction.js";
export type { Logger } from "./redaction.js";

export { anthropicAdapter } from "./providers/anthropic.js";
export { openaiAdapter } from "./providers/openai.js";

export { parseProposal, validateProposalDraft } from "./parseProposal.js";
export {
  runProposalTurn,
  type ProposalTurnGateway,
  type ProposalTurnResult,
} from "./propose.js";
export { proposalPolicyMessage } from "./proposalPrompt.js";

export type {
  ProviderAdapter,
  ProviderContext,
  FetchLike,
} from "./types.js";

export type {
  ProviderId,
  ModelSpec,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  TokenUsage,
  SafeError,
  GatewayErrorVariant,
  KeyStoreState,
  AiStatus,
  AiSendResult,
  AiSetKeyResult,
} from "../shared/ai.js";
