// deploy-stamp: 2026-07-05 App Check CORS rollout (forces a fresh source hash
// after a partial deploy left stale code serving with a current hash label)
import {setGlobalOptions} from "firebase-functions/v2";
import {onRequest} from "firebase-functions/v2/https";
import {withCorsAndErrorHandling} from "./middleware/errorHandler";
import {handleChatCompletion} from "./services/openai/handler";
import {handleGeminiChat} from "./services/gemini/handler";
import {handleWhisper} from "./services/whisper/handler";
import {handlePerplexitySearch} from "./services/perplexity/handler";
import {handleFeedback} from "./services/feedback/handler";
import {handleClaudeChat} from "./services/claude/handler";
import {handleOpenAiCompatibleGateway} from
  "./services/openai-compatible-gateway/handler";
import {parseList} from "./utils/parser";
import {handleMembershipAdmin} from "./services/membership/handler";

setGlobalOptions({
  maxInstances: 10,
  secrets: [
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "PERPLEXITY_API_KEY",
    "ANTHROPIC_API_KEY",
    "RESEND_API_KEY",
  ],
});

export const proxyWhisper = onRequest(
  {timeoutSeconds: 300, memory: "1GiB"},
  withCorsAndErrorHandling(handleWhisper),
);

export const proxyGeminiChat = onRequest(
  {timeoutSeconds: 300, memory: "1GiB"},
  withCorsAndErrorHandling(handleGeminiChat),
);

export const proxyChatCompletion = onRequest(
  {timeoutSeconds: 300, memory: "1GiB"},
  withCorsAndErrorHandling(handleChatCompletion),
);

export const proxyPerplexitySearch = onRequest(
  {timeoutSeconds: 300, memory: "1GiB"},
  withCorsAndErrorHandling(handlePerplexitySearch),
);

export const proxyClaudeChat = onRequest(
  {timeoutSeconds: 300, memory: "1GiB"},
  withCorsAndErrorHandling(handleClaudeChat),
);

export const sendFeedback = onRequest(
  {timeoutSeconds: 60, memory: "512MiB"},
  withCorsAndErrorHandling(handleFeedback),
);

const gatewayOrigins = parseList(process.env.ALLOWED_ORIGINS);
const PROD_GATEWAY_ORIGINS = gatewayOrigins.length > 0 ? gatewayOrigins : [
  "https://mediprisma.tw",
  "https://voho0000.github.io",
];

export const proxyOpenAiCompatibleGateway = onRequest(
  {
    timeoutSeconds: 540,
    memory: "1GiB",
    // This BYO-key gateway must not inherit the owner-funded provider secrets
    // bound globally above. It forwards only the caller's ephemeral key.
    secrets: [],
  },
  withCorsAndErrorHandling(handleOpenAiCompatibleGateway, {
    origins: PROD_GATEWAY_ORIGINS,
    appCheckEnforce: true,
  }),
);

// ---------------------------------------------------------------------------
// Dev group — deployed as separate `dev-*` functions with their own URLs, so
// localhost can exercise contract changes (new headers, App Check enforce)
// against real Cloud Run infra while production stays untouched.
// Deploy with `npm run deploy:dev`; `npm run deploy:prod` never touches these.
// Same handlers, same secrets; only construction-time options differ.
// ---------------------------------------------------------------------------

// Ports the app's own dev servers listen on (see the app repo's
// .claude/launch.json). Feature work runs in parallel git worktrees, each on
// its own port, and a worktree whose port is missing here fails EVERY proxy
// call at the CORS preflight — which reads as "the AI is broken", not as a
// configuration gap. Listed explicitly rather than allowing any localhost
// port: these functions hold owner-funded provider keys, so the set of local
// callers stays enumerated. Add a port here when a new worktree needs one.
const DEV_LOCALHOST_PORTS = [3001, 3011, 3013];
const DEV_LOCALHOST_ORIGINS = DEV_LOCALHOST_PORTS.flatMap((port) => [
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
]);

const DEV_HANDLER_OPTIONS = {
  // localhost only — the deployed app must never point at dev-* URLs.
  origins: DEV_LOCALHOST_ORIGINS,
  // App Check stays log-only here for now: the app has no debug-token flow
  // on localhost yet, so enforcing would 401 every local call. Flip to true
  // to rehearse enforcement in dev before production.
  appCheckEnforce: undefined,
};

// maxInstances 2 (vs the global 10): caps the blast radius of a runaway
// loop during local development.
const DEV_PROXY_RUNTIME = {
  timeoutSeconds: 300,
  memory: "1GiB" as const,
  maxInstances: 2,
};

export const dev = {
  manageTenantMembership: onRequest(
    {timeoutSeconds: 60, memory: "512MiB", maxInstances: 2},
    withCorsAndErrorHandling(handleMembershipAdmin, DEV_HANDLER_OPTIONS),
  ),
  proxyWhisper: onRequest(
    DEV_PROXY_RUNTIME,
    withCorsAndErrorHandling(handleWhisper, DEV_HANDLER_OPTIONS),
  ),
  proxyGeminiChat: onRequest(
    DEV_PROXY_RUNTIME,
    withCorsAndErrorHandling(handleGeminiChat, DEV_HANDLER_OPTIONS),
  ),
  proxyChatCompletion: onRequest(
    DEV_PROXY_RUNTIME,
    withCorsAndErrorHandling(handleChatCompletion, DEV_HANDLER_OPTIONS),
  ),
  proxyPerplexitySearch: onRequest(
    DEV_PROXY_RUNTIME,
    withCorsAndErrorHandling(handlePerplexitySearch, DEV_HANDLER_OPTIONS),
  ),
  proxyClaudeChat: onRequest(
    DEV_PROXY_RUNTIME,
    withCorsAndErrorHandling(handleClaudeChat, DEV_HANDLER_OPTIONS),
  ),
  sendFeedback: onRequest(
    {timeoutSeconds: 60, memory: "512MiB", maxInstances: 2},
    withCorsAndErrorHandling(handleFeedback, DEV_HANDLER_OPTIONS),
  ),
  proxyOpenAiCompatibleGateway: onRequest(
    {...DEV_PROXY_RUNTIME, timeoutSeconds: 540, secrets: []},
    withCorsAndErrorHandling(
      handleOpenAiCompatibleGateway,
      DEV_HANDLER_OPTIONS,
    ),
  ),
};
