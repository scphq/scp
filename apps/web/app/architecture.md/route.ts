import { markdownResponse, mdHref } from "../../lib/markdown";

export const dynamic = "force-static";

export const GET = () => markdownResponse(mdHref("/architecture"));
