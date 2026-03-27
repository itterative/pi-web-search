import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import webExploreTool from "./tools/web-explore";
import webFetchTool from "./tools/web-fetch";
import webSearchTool from "./tools/web-search";

export default function (pi: ExtensionAPI) {
    webSearchTool(pi);
    webFetchTool(pi);
    webExploreTool(pi);
}
