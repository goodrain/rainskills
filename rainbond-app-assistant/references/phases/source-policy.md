# source-policy

5. 当前项目一旦被判定为 `source-backed`，不能静默改成 `package` 或 `image`。
   transport 代理只改“怎么拉”，不改 delivery mode。

8. 一旦 source ref 已确定，不能静默改 branch/ref。
   分支不存在时必须停住并报告 source definition needs confirmation。

14. 任何 delivery mode 或 workaround 策略切换都不允许隐式发生。
    source -> package、source -> image、source -> template 都必须先得到用户明确确认。

24. 不要自动拉起本地 Docker Desktop/OrbStack、执行本地 Docker build/push、或推送临时镜像作为兜底；这属于 delivery-mode 策略切换，必须先得到用户明确确认。

38. **用户显式源码意图优先（禁止"先装模板再改主意手搓"）**：当用户消息里**明确给出了 Git 仓库 URL**（或明确说"部署这个仓库 / 这个项目的源码"），本轮部署路径**锁定为源码 / compose 画像路径**。
    - 应用市场模板（`rainbond_install_app_model` / 云市场版本）只能作为**建议提及**（"该应用市场也有现成的 X 模板，需要的话可以改用"），在用户**明确选择**模板之前**禁止执行模板安装**。
    - **禁止**这条真实反例链路：用户给了 GitHub URL → 模型先建应用装了云市场模板（`is_deploy=true`）→ 发现不对又放弃 → 另建应用手搓镜像组件 → 留下一个半装的废弃应用没清理。每一步都消耗用户授权、且制造垃圾资源。
    - 如果策略切换确实发生（例如确认源码路径走不通、用户改主意要用模板），切换前**必须先清理废弃的半成品应用**（删掉上一条路径建出来的应用/组件），或在切换时**明确告知用户存在这个半成品并征求处理意见**，不允许默默留着。
    - 与 Iron Law 14（delivery mode 切换必须用户确认）配套：14 管 source↔package↔image↔template 的策略切换需用户确认，38 管"用户已经显式给了源码意图时，模板不是默认路径、且切换必须清理残留"。
