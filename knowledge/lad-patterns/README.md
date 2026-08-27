# LAD FlgNet 实证样板

本目录保存经 Siemens TIA Portal V21 实际导入、编译和回导验证的 LAD/FlgNet 样板。归档的 `*_V21.xml` 是 TIA V21 回导产物，不是手写候选 XML；旧 `MCPVerify_*` 文件由原 `engine/tia-mcp/tools/tiaportal-mcp/skill/lad-cookbook/` 目录整体迁移而来。

## 本轮验证

- 验证日期：2026-08-26。
- TIA Portal：V21；PLC：S7-1500，`6ES7513-1AM03-0AB0`。
- 正向 oracle 工程位于仓库外的临时验证目录，不进入 Git 或绿色包。
- `TASK012A_NonTO_Verify_V21.xml`：起保停真实并联自锁、`CTU_INT`、`TOF_TIME`、`NBox` 下降沿、FC 调用、FB 多重实例。
- `TASK012A_FC_Callee_V21.xml` 与 `TASK012A_FB_Callee_V21.xml`：被调 FC/FB 块。
- 三份回导 XML 导入全新工程：3/3 成功，失败 0。
- 干净工程独立编译：0 errors，0 warnings。
- 将 `Start` 成对改名为 `StartRenamed` 后再次导入：3/3 成功，失败 0；独立编译：0 errors，0 warnings。

## 已确认的结构

- `CTU` 使用 `Instance Scope="LocalVariable"`，实例成员为 `BatchCnt`，模板为 `value_type=Int`；引脚为 `CU/R/PV/CV/Q`。
- `TOF` 使用 `Instance Scope="LocalVariable"`，实例成员为 `OffDelay`，模板为 `time_type=Time`；引脚为 `IN/PT/ET/Q`，未接 `ET` 必须使用 `OpenCon`。
- `NBox` 下降沿结构为 `Part Name="NBox"`，引脚为 `in/bit/out`。
- FC 调用使用 `<Call>` 与 `<CallInfo BlockType="FC">`，不带实例；FB 多重实例使用 `<CallInfo BlockType="FB">`，并通过 Static 成员 `Child` 的 `Instance` 引用。
- 起保停并联使用 `Part Name="O"` 与 `TemplateValue Card=2`，真实验证文件已归档。

## 未验证与冻结

- `MC_Power`、`MC_MoveRelative` 和工艺对象引用未能在本机验证：V21 界面将 `BasicPosControl` 显示为灰色并提示“不支持该版本的工艺对象”，因此按裁决冻结到 `TASK-012B`。
- `CTD`、`CTUD`、`TP` 仍未验证。
- 本目录不收录未经 V21 导入/编译验证的 MC XML。
