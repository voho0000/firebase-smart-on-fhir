import {setGlobalOptions} from "firebase-functions/v2";
import {onRequest} from "firebase-functions/v2/https";
import {withCorsAndErrorHandling} from "./middleware/errorHandler";
import {handleChatCompletion} from "./services/openai/handler";
import {handleGeminiChat} from "./services/gemini/handler";
import {handleWhisper} from "./services/whisper/handler";
import {handlePerplexitySearch} from "./services/perplexity/handler";

setGlobalOptions({
  maxInstances: 10,
  secrets: ["OPENAI_API_KEY", "GEMINI_API_KEY", "PERPLEXITY_API_KEY"],
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
