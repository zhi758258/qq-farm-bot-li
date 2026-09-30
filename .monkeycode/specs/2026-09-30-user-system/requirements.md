# Requirements Document

## Introduction

为 QQ 农场 Web 面板增加多用户系统。登录页提供公开自助注册；注册成功后系统为该用户分配额度 99（该用户最多可绑定的游戏账号数量）。超级管理员继续存在，可无限绑定游戏账号，并管理全部用户与额度。普通用户仅能管理自己绑定的游戏账号。

## Glossary

- **System**: QQ 农场 Web 面板及其后端服务
- **Super Admin**: 现有超级管理员账号，角色为 `admin`，可管理全部用户、全部游戏账号与系统设置
- **User**: 通过注册创建的普通面板用户，角色为 `user`
- **Quota**: 用户额度，表示该用户允许绑定的游戏账号数量上限；注册时默认值为 99
- **Game Account**: 绑定到某一 User 或 Super Admin 的 QQ/微信农场账号
- **Session Token**: 登录成功后签发的访问令牌，用于 HTTP API 与 Socket.IO 鉴权

## Requirements

### Requirement 1: 用户注册

**User Story:** AS 访客, I want 使用用户名和密码自助注册, so that 我可以获得一个独立的面板账号并开始使用挂机功能

#### Acceptance Criteria

1. WHEN 访客提交合法的用户名和密码, THE System SHALL 创建角色为 `user` 的新用户
2. WHEN 新用户创建成功, THE System SHALL 将该用户的 Quota 设置为 99
3. WHEN 访客提交的用户名已被 Super Admin 或其他 User 使用, THE System SHALL 返回错误并拒绝创建
4. IF 用户名长度不在 3 到 32 个字符之间，或用户名包含字母、数字、下划线以外的字符, THE System SHALL 拒绝注册并返回明确错误
5. IF 密码不满足现有密码强度规则, THE System SHALL 拒绝注册并返回明确错误

### Requirement 2: 用户登录与会话

**User Story:** AS User 或 Super Admin, I want 使用用户名和密码登录, so that 我可以访问面板并保持会话

#### Acceptance Criteria

1. WHEN User 或 Super Admin 提交正确的用户名和密码, THE System SHALL 签发 Session Token 并返回角色、用户名与 Quota
2. WHEN 登录凭证错误, THE System SHALL 返回错误，并沿用现有 IP 频率限制与失败锁定策略
3. WHILE Session Token 有效, THE System SHALL 允许该用户访问其权限范围内的 HTTP API 与 Socket.IO
4. WHEN 用户调用登出接口, THE System SHALL 使该 Session Token 立即失效

### Requirement 3: 额度约束游戏账号数量

**User Story:** AS User, I want 系统按我的额度限制可绑定的游戏账号数量, so that 我不会超出分配的账号上限

#### Acceptance Criteria

1. WHILE User 已绑定的游戏账号数量小于该用户 Quota, THE System SHALL 允许该用户新增游戏账号
2. WHEN User 已绑定的游戏账号数量达到该用户 Quota, THE System SHALL 拒绝新增游戏账号并返回额度不足错误
3. WHEN Super Admin 新增游戏账号, THE System SHALL 允许添加且不检查 Quota
4. WHEN 查询当前用户信息, THE System SHALL 返回 Quota 与已使用额度

### Requirement 4: 数据隔离

**User Story:** AS User, I want 只看到并操作我自己的游戏账号, so that 其他用户的数据保持隔离

#### Acceptance Criteria

1. WHILE User 已登录, THE System SHALL 仅返回属于该用户的游戏账号、日志、状态与实时推送
2. WHEN User 请求不属于该用户的游戏账号, THE System SHALL 返回未找到或无权限错误
3. WHILE Super Admin 已登录, THE System SHALL 允许查看和管理全部游戏账号与全部用户
4. WHEN 现有未绑定 owner 的游戏账号被加载, THE System SHALL 将其归属到 Super Admin，以保持升级兼容

### Requirement 5: 管理员管理用户与额度

**User Story:** AS Super Admin, I want 查看用户列表并调整用户额度, so that 我可以控制每个用户可绑定的游戏账号数量

#### Acceptance Criteria

1. WHEN Super Admin 请求用户列表, THE System SHALL 返回每个用户的用户名、角色、Quota、已使用额度、创建时间与启用状态
2. WHEN Super Admin 将某一 User 的 Quota 更新为非负整数, THE System SHALL 持久化该额度
3. IF Super Admin 将 Quota 设置为小于该用户当前已绑定游戏账号数量, THE System SHALL 拒绝更新并返回明确错误
4. WHEN Super Admin 禁用某一 User, THE System SHALL 使该用户现有 Session Token 失效，并拒绝该用户后续登录
5. WHEN 普通 User 请求用户管理接口, THE System SHALL 返回无权限错误

### Requirement 6: 用户修改自身密码与查看自身信息

**User Story:** AS User, I want 查看我的账号信息并修改密码, so that 我可以管理自己的面板账号

#### Acceptance Criteria

1. WHEN 已登录用户请求自身信息, THE System SHALL 返回用户名、角色、Quota、已使用额度
2. WHEN 已登录用户提交正确的原密码和符合强度规则的新密码, THE System SHALL 更新密码并使该用户全部 Session Token 失效
3. IF 原密码错误, THE System SHALL 拒绝修改并返回明确错误
