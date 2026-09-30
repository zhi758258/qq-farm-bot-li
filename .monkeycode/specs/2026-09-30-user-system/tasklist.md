# 需求实施计划

- [x] 1. 扩展会话与账号数据模型
  - 将 `AdminContext.tokens` 从 `Set<string>` 改为 `Map<string, Session>`，定义 `Session`（token、userId、username、role）
  - 为 `Account` 增加 `ownerId`；`normalizeAccount` 将空归属写为 `admin`
  - 新增账号时写入 `ownerId`（Req 4.4, Design 会话与账号模型）

- [x] 2. 实现 user-store 与用户名校验
  - 新增 `core/src/models/user-store.ts`，持久化 `data/users.json`
  - 实现 `DEFAULT_USER_QUOTA = 99`、注册、校验、改密、列用户、改额度、启用/禁用、统计已绑账号、用户名占用检查
  - 用户名 3–32 位仅字母数字下划线；密码复用 `auth-security`（Req 1, Req 5, Req 6）

- [x] 2.1 为 user-store 编写单元测试
  - 覆盖注册默认额度 99、重复用户名、非法用户名与密码、额度不能小于已用数量

- [x] 3. 改造鉴权中间件与登录注册接口
  - `createAuthRequired` 将会话写入 `req.auth`；公开 `/api/register`、`/api/login`、`/api/game-version`
  - 登录先匹配管理员再匹配普通用户；注册成功签发 token 并返回 quota=99
  - `/api/user/me` 返回角色、quota、usedQuota；改密清除该用户全部会话
  - 管理员接口：列出用户、改额度、启用/禁用；普通用户访问返回 403（Req 1–2, 5–6）

- [x] 4. 按 owner 隔离游戏账号并执行额度校验
  - 账号列表、删除、启停、日志、状态按 session 过滤
  - 普通用户新增账号时检查 `usedQuota < quota`，额度用尽返回 403
  - 超级管理员新增账号不检查额度；普通用户访问他人账号返回 404（Req 3–4）

- [x] 5. Socket.IO 按会话限制订阅范围
  - 握手写入 `socket.data.session`
  - 普通用户只能订阅自己的账号；订阅 all 时只加入自己名下房间（Req 4.1）

- [x] 6. 检查点 - 确保后端核心路径可用
  - 确保所有测试通过,如有疑问请询问用户

- [x] 7. 前端登录注册与用户状态
  - `Login.vue` 增加注册切换并调用 `/api/register`
  - `stores/user.ts` 支持 `admin | user`、quota、usedQuota
  - 侧栏展示角色与额度；管理员显示不限（Req 1–2, 6）

- [x] 8. 管理员用户管理页签与额度不足提示
  - 设置页增加仅管理员可见的用户管理页签，支持改额度、禁用
  - 添加游戏账号失败时展示额度不足错误（Req 3, Req 5）

- [x] 9. 更新 README 用户系统说明
  - 将「只保留一个超级管理员」改为公开注册、默认额度 99、管理员不限账号

- [x] 10. 检查点 - 确保所有测试通过
  - 确保所有测试通过,如有疑问请询问用户
