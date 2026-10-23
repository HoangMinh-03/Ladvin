// Entry for dist/ladvin-hook.js: `node ladvin-hook.js post|stop` with the hook JSON on stdin.
import { runHook } from "./hook";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let input = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {}
  const event = process.argv[2] === "stop" ? "stop" : "post";
  const out = runHook(event, input, process.env);
  if (out) process.stdout.write(out);
  process.exit(0);
});
