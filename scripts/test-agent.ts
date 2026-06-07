import { agentQuery } from "./util.js";

const result = await agentQuery("summarize the readme in the first package dir");
console.log(result);
