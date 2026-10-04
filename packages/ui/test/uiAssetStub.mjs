// node:test 直跑 ui 模块时，部分 .tsx 会传递引入 ProviderLogo 等静态资源
// （provider-icons/*.png）。Node 无法加载这些扩展名；这里统一短路成空模块，
// 只服务纯逻辑单测，不参与任何打包产物。
import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    if (/\.(png|svg|css|woff2?)(?:$|\?)/.test(url)) {
      return { format: "module", shortCircuit: true, source: "export default undefined;" };
    }
    return nextLoad(url, context);
  },
});
