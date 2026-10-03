import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import { nodeResolve } from "@rollup/plugin-node-resolve";

export default ["index", "cleanup"].map((entry) => ({
  input: `src/${entry}.js`,
  output: {
    esModule: true,
    file: `dist/${entry}.js`,
    inlineDynamicImports: true,
    format: "es",
    sourcemap: true,
  },
  plugins: [json(), commonjs(), nodeResolve({ preferBuiltins: true })],
}));
