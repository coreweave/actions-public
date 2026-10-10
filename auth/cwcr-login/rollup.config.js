import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import { nodeResolve } from "@rollup/plugin-node-resolve";

const plugins = [nodeResolve({ preferBuiltins: true }), commonjs(), json()];

export default [
  {
    input: "src/index.js",
    output: { file: "compiled/index.cjs", format: "cjs" },
    plugins,
  },
  {
    input: "src/token-main.js",
    output: { file: "compiled/token.cjs", format: "cjs" },
    plugins,
  },
  {
    input: "src/cleanup-main.js",
    output: { file: "compiled/cleanup.cjs", format: "cjs" },
    plugins,
  },
];
