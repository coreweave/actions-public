import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import { nodeResolve } from "@rollup/plugin-node-resolve";

export default {
  input: "src/index.js",
  output: { file: "compiled/index.cjs", format: "cjs" },
  plugins: [nodeResolve({ preferBuiltins: true }), commonjs(), json()],
};
