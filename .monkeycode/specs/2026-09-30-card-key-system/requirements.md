# Requirements Document

## Introduction

为 QQ 农场 Web 面板增加时间卡密系统。访客注册必须填写一张未使用的时间卡密；核销成功后，系统按该卡的天数设置 User 的到期时间。超级管理员可批量创建时间卡密、查看库存，并决定是否开放注册页免费领取。领取开关打开后，注册页卡密输入框旁显示领取按钮；领取成功后将卡密自动填入输入框。

## Glossary

- **System**: QQ 农场 Web 面板及其后端服务
- **Super Admin**: 角色为 `admin` 的超级管理员
- **Visitor**: 未登录的访客
- **User**: 通过注册创建的普通面板用户
- **Time Card Key**: 管理员创建的一次性时间卡密，含有效天数；注册核销后用于设置 User 到期时间
- **Claim Switch**: 管理员控制的开关；打开后注册页允许免费领取一张未使用的 Time Card Key
- **Stock**: 当前尚未使用、可供领取或填写注册的 Time Card Key 数量
- **Expires At**: User 账号到期时间；到期后该 User 无法登录面板

## Requirements

### Requirement 1: 注册必须核销时间卡密

**User Story:** AS Super Admin, I want 访客注册时必须填写有效时间卡密, so that 面板账号的创建和有效期受控

#### Acceptance Criteria

1. WHEN Visitor 提交注册请求且未提供 Time Card Key, THE System SHALL 拒绝注册并返回明确错误
2. WHEN Visitor 提交尚未使用的有效 Time Card Key 以及合法用户名与密码, THE System SHALL 创建 User，将该 Time Card Key 标记为已使用，并将该 User 的 Expires At 设置为当前时间加上该卡的天数
3. WHEN Visitor 提交不存在或已使用的 Time Card Key, THE System SHALL 拒绝注册并返回明确错误
4. WHEN 注册因用户名或密码校验失败, THE System SHALL 保持该 Time Card Key 为未使用状态

### Requirement 2: 管理员管理时间卡密与领取开关

**User Story:** AS Super Admin, I want 创建时间卡密并控制是否允许免费领取, so that 我可以按库存发放注册凭证

#### Acceptance Criteria

1. WHEN Super Admin 请求创建指定数量、天数和描述的 Time Card Key, THE System SHALL 生成对应数量的未使用时间卡密并持久化
2. WHEN Super Admin 打开 Claim Switch, THE System SHALL 允许注册页领取未使用的 Time Card Key
3. WHEN Super Admin 关闭 Claim Switch, THE System SHALL 拒绝注册页领取请求
4. WHEN Super Admin 查询卡密管理数据, THE System SHALL 返回 Claim Switch 状态、Stock 数量以及卡密列表（含卡密、描述、天数、使用状态）
5. WHEN 普通 User 请求卡密管理接口, THE System SHALL 返回无权限错误

### Requirement 3: 注册页领取卡密并自动填入

**User Story:** AS Visitor, I want 在注册页领取时间卡密并自动填入, so that 我可以完成注册

#### Acceptance Criteria

1. WHILE Claim Switch 已打开 且 注册页已显示, THE System SHALL 在卡密输入框旁显示领取卡密按钮
2. WHILE Claim Switch 已关闭, THE System SHALL 显示卡密输入框且隐藏领取卡密按钮
3. WHEN Visitor 点击领取卡密且 Stock 大于 0, THE System SHALL 返回一张未使用 Time Card Key，并由注册页自动填入卡密输入框
4. WHEN Visitor 点击领取卡密且 Stock 等于 0, THE System SHALL 返回库存不足错误
5. WHEN Visitor 点击领取卡密且 Claim Switch 已关闭, THE System SHALL 返回领取未开启错误

### Requirement 4: 到期用户无法登录

**User Story:** AS Super Admin, I want 时间卡到期后停止该用户登录, so that 过期账号不再使用面板

#### Acceptance Criteria

1. WHEN User 的 Expires At 早于当前时间且该 User 尝试登录, THE System SHALL 拒绝登录并返回账号已过期错误
2. WHILE Super Admin 已登录, THE System SHALL 允许访问且不检查 Expires At
3. WHEN 查询 User 信息, THE System SHALL 返回 Expires At
