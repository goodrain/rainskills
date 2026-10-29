---
name: rainbond-scheduled-task
description: Create, inspect, pause, resume, delete, or trial-run recurring (cron) Rainbond scheduled tasks for enterprise administrators, using the schedule_* tools. Exclude one-time reminders and non-admin users.
---

# Rainbond Scheduled Task

## Purpose

用自然语言管理**周期**定时任务：创建、查看、修改、启停、删除、试跑、看运行历史。

只支持 cron 周期任务；一次性提醒不支持。仅企业管理员可用（工具对成员不注册，直接告知无权限）。

## Fast path

1. Read the [generated Runtime Gate](references/generated/runtime-gate.md) once per session; if absent, follow [generated Runtime Routing](references/generated/runtime-routing.md).
2. 解析：频率、目标（team/region/app/component）、要执行的 prompt、是否需要飞书通知。
3. 用**一句话**向用户确认，不铺表格：

   > 每天 09:00 巡检 default/rainbond 的 nginx，汇总结果、仅记录。确认创建？

4. 确认后调用 `schedule_create_task`；成功只回一句“已创建，下次 10-30 09:00”。

## Field mapping

| 用户表达 | 取值 |
|---|---|
| 每天 9 点 | `0 9 * * *` |
| 每周一 10 点 | `0 10 * * 1` |
| 每 30 分钟 | `*/30 * * * *` |
| 未指定目标 | 使用当前会话的 team/region/app/component |
| “有问题发飞书” | `notification_policy=attention_required` |
| 未指定通知 | `notification_policy=record_only` |
| 结果模式 | 固定 `result_mode=report`（汇总） |
| 审批 | 固定 `approval_mode=manual`，高风险与删除永远人工 |

## Management

| 请求 | 工具 |
|---|---|
| 看有哪些任务 | `schedule_list_tasks` |
| 改成 8 点半 | `schedule_update_task` |
| 先暂停 / 恢复 | `schedule_set_task_enabled` |
| 删除 | `schedule_delete_task`（先二次确认） |
| 现在跑一次 | `schedule_test_task` |
| 最近结果 | `schedule_list_runs` |
| 飞书是否就绪 | `schedule_check_notification` |

## Constraints

- 不要说“已创建”除非工具返回成功；
- 不猜企业 ID，不跨企业创建；
- 删除、停用必须二次确认；
- 定时任务运行不写记忆，不要向用户承诺“会记住上次巡检”；
- 通知策略非 `record_only` 时，先 `schedule_check_notification`，未就绪则提示先绑定飞书群。
