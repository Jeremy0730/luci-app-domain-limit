# luci-app-domain-limit

[![English](https://img.shields.io/badge/English-switch-lightgrey)](README.md) [![简体中文](https://img.shields.io/badge/简体中文-当前-blue)](README.zh-CN.md)

按设备（MAC 或 IPv4）对指定 App 和域名限速或禁止访问的 LuCI 插件，其它网站不受影响。

- **App 预设**：直接勾选抖音、快手、微博、小红书、哔哩哔哩、爱奇艺、优酷、TikTok、YouTube、Netflix、Instagram、Twitch、Steam、Windows 更新、苹果系统更新，不用自己找域名；也可以再补充额外域名
- **限速或禁止**：按 Mbps 限制上下行，或者直接断开
- **时段控制**：只在指定星期的某个时间段生效（可以跨午夜，例如 22:00–07:00）
- **可用时长**：每个时段内先放行 N 分钟，用完后才限速或禁止；时段结束时清零（没有设置时段的规则在午夜清零）
- **阶梯限制**：写在同一条规则里，一次配完，最多 3 级。例如用满 30 分钟后 4 Mbps，60 分钟后 2 Mbps，90 分钟后禁止。一台设备只能有一条规则

- 适用：OpenWrt / ImmortalWrt 23.05 及以上（fw4），推荐 25.12
- 依赖：`luci-base`、`firewall4`、`dnsmasq-full`
- 架构无关（noarch），所有机型通用

## 安装

### 方式一：添加软件源（推荐，之后可在「系统 → 软件包」里搜到和升级）

**25.12 及以上（apk）**

```sh
wget -O /etc/apk/keys/domain-limit.pem https://jeremy0730.github.io/luci-app-domain-limit/keys/domain-limit.pem
echo https://jeremy0730.github.io/luci-app-domain-limit/apk/packages.adb >> /etc/apk/repositories.d/customfeeds.list
apk update
apk add luci-app-domain-limit luci-i18n-domain-limit-zh-cn
```

**24.10 及以下（opkg）**

```sh
wget -O /etc/opkg/keys/bea6a2687ea8c643 https://jeremy0730.github.io/luci-app-domain-limit/keys/bea6a2687ea8c643
echo 'src/gz domain_limit https://jeremy0730.github.io/luci-app-domain-limit/ipk' >> /etc/opkg/customfeeds.conf
opkg update
opkg install luci-app-domain-limit luci-i18n-domain-limit-zh-cn
```

添加软件源后，也可以在 LuCI「系统 → 软件包」里点「更新列表」，再搜索 `domain-limit` 安装。

### 方式二：手动安装

从 [Releases](https://github.com/Jeremy0730/luci-app-domain-limit/releases) 下载对应格式的包，在「系统 → 软件包 → 上传软件包」安装，或：

```sh
apk add --allow-untrusted ./luci-app-domain-limit-*.apk   # 25.12+
opkg install ./luci-app-domain-limit_*_all.ipk            # 24.10-
```

## 使用

菜单位置：「服务 → 域名限速」。

1. 打开总开关。
2. 添加规则。在「规则」页选择设备（MAC 优先），勾选 App 和/或填写额外域名（`example.com` 会同时匹配所有子域名），动作选「限速」并填写上下行速率（Mbps），或选「禁止访问」。
3. 在「限制」页选一种方式。马上限制：规则一生效就限速或禁止。先放开：填写可自由使用的分钟，用完后只执行一次动作。逐级收紧：在同一条规则里最多填 3 级，例如 30 分钟后下行/上行 4 Mbps，60 分钟后 2 Mbps，90 分钟后禁止。需要的话再设置每天的生效小时。一台设备只能有一条规则；同一 MAC 或地址请编辑已有规则，不要再新建。
4. 保存并应用。页面上方会显示每条规则的状态（限速中、禁止中、阶梯当前速率、时长未用完、不在生效时段）、当前时段已用分钟、已收录的 IP 数量和丢包计数。

注意：

- App 域名列表尽量收全但不保证完整。App 会更换域名，有些还用自带的 DNS（HTTPDNS）或写死的 IP，可能有少量请求漏过，缺的域名可以填在「额外域名」里。
- 可用时长只统计真正有流量（约 20 kbit/s 以上）的分钟。用量保存在内存里，路由器重启后从零开始。
- 阶梯和可自由使用的分钟一样，只统计真正有流量的分钟，并随时段结束清零（全天生效则在午夜清零）。第一级之前不限速。每一级分别填写下行和上行。最多 3 级。每台设备只能有一条规则。
- 时段按路由器的时区计算（「系统 → 系统」）。跨午夜的时段（例如 22:00–07:00）算同一个时段，午夜不会清零。想设全天，把开始和结束设成同一个时间。

- 被限速的设备必须使用路由器做 DNS。手机「私人 DNS」、浏览器「安全 DNS（DoH）」会绕过域名匹配。可以在防火墙里把 LAN 的 53 端口劫持到路由器。
- 必须关闭软件/硬件流量分载（flow offloading）、Turbo ACC、NSS 等加速，否则限速被绕过。
- 只填 IPv4 地址时，只限制 IPv4；填 MAC 时 IPv4 和 IPv6 都限制。

## 工作原理

- dnsmasq 的 `nftset=` 把目标域名解析出的地址写入 nftables 集合；守护进程每 10 分钟也会自己解析一次补充。
- fw4 的 forward 链里，来自目标设备、发往集合内地址的连接被打上 conntrack 标记（包括规则生效前已经建立的连接）。
- 带标记的流量按当前阶梯的上下行分别用 `limit rate over … drop` 限速；禁止阶梯直接丢弃。每条规则有一个命名计数器用来统计用量。
- 守护进程每 30 秒用一次 nft 调用读出全部计数器，检查各规则的时段和已用时长，把连接标记放进对应的阶梯集合（`dl_t0` 起）。升降级不需要重载防火墙。

## 编译

### 使用 OpenWrt / ImmortalWrt SDK

```sh
# 在 SDK 根目录
echo "src-git domain_limit https://github.com/Jeremy0730/luci-app-domain-limit.git" >> feeds.conf.default
./scripts/feeds update -a
./scripts/feeds install -a
make package/luci-app-domain-limit/compile V=s
```

也可以把 `luci-app-domain-limit/` 目录复制到 `feeds/luci/applications/` 或 `package/` 下编译。

### GitHub Actions

`.github/workflows/build.yml` 用 ImmortalWrt SDK 编译 apk（25.12）和 ipk（24.10）两种格式，并生成签名的软件源索引。

推送 `v*` 标签（必须与 Makefile 里的 `PKG_VERSION` 一致，例如 `v1.0.0`）时会：

1. 把安装包上传到 GitHub Release；
2. 把软件源发布到 GitHub Pages：`https://jeremy0730.github.io/luci-app-domain-limit/`。

需要在仓库 Settings 里设置：

- **Secrets and variables → Actions**：
  - `APK_PRIVATE_KEY`：apk 索引签名私钥（ECDSA P-256 PEM）
  - `USIGN_KEY_BUILD`：opkg 索引签名私钥（usign 格式）
- **Pages → Build and deployment → Source**：选 GitHub Actions

对应的公钥在 [`keys/`](keys/)。私钥丢失后需要生成新密钥、替换 `keys/` 并通知用户重新导入公钥。

### 本地快速打包（不需要 SDK，不含翻译）

```sh
python tools/build_ipk.py   # 输出 dist/*.ipk 和 dist/*.apk
```

## 许可证

[Apache-2.0](LICENSE)
