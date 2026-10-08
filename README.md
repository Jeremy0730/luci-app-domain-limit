# luci-app-domain-limit

[![English](https://img.shields.io/badge/English-current-blue)](README.md) [![简体中文](https://img.shields.io/badge/简体中文-点击切换-lightgrey)](README.zh-CN.md)

A LuCI app that limits or blocks selected apps and domains for selected devices (by MAC or IPv4). Other sites are not affected.

- **App presets**: pick Douyin, Kuaishou, Weibo, Xiaohongshu, Bilibili, iQIYI, Youku, TikTok, YouTube, Netflix, Instagram, Twitch, Steam, Windows Update or Apple software updates instead of typing domains; add extra domains as needed
- **Limit or block**: cap download/upload in Mbps, or drop the traffic entirely
- **Time windows**: apply a rule only on chosen weekdays between two times (windows may cross midnight, e.g. 22:00–07:00)
- **Allowance**: let a device use the apps freely for N minutes within each time window, then apply the limit or block; the count is cleared when the window ends (at midnight for rules without a window)

- Works on: OpenWrt / ImmortalWrt 23.05 and later (fw4); 25.12 recommended
- Depends on: `luci-base`, `firewall4`, `dnsmasq-full`
- Architecture independent (noarch), runs on any device

## Installation

### Option 1: add the package feed (recommended; the app then shows up in System → Software and can be upgraded there)

**25.12 and later (apk)**

```sh
wget -O /etc/apk/keys/domain-limit.pem https://jeremy0730.github.io/luci-app-domain-limit/keys/domain-limit.pem
echo https://jeremy0730.github.io/luci-app-domain-limit/apk/packages.adb >> /etc/apk/repositories.d/customfeeds.list
apk update
apk add luci-app-domain-limit
```

**24.10 and earlier (opkg)**

```sh
wget -O /etc/opkg/keys/bea6a2687ea8c643 https://jeremy0730.github.io/luci-app-domain-limit/keys/bea6a2687ea8c643
echo 'src/gz domain_limit https://jeremy0730.github.io/luci-app-domain-limit/ipk' >> /etc/opkg/customfeeds.conf
opkg update
opkg install luci-app-domain-limit
```

For the Simplified Chinese interface, also install `luci-i18n-domain-limit-zh-cn`.

After adding the feed you can also click "Update lists" in LuCI under System → Software and search for `domain-limit`.

### Option 2: manual install

Download the package from [Releases](https://github.com/Jeremy0730/luci-app-domain-limit/releases) and install it with System → Software → Upload Package, or:

```sh
apk add --allow-untrusted ./luci-app-domain-limit-*.apk   # 25.12+
opkg install ./luci-app-domain-limit_*_all.ipk            # 24.10 and earlier
```

## Usage

Menu: Services → Domain Rate Limit.

1. Turn on the main switch.
2. Add a rule. On the **Rule** tab pick a device (MAC preferred), select apps and/or enter extra domains (`example.com` also matches all of its subdomains), then choose **Limit speed** with download/upload rates in Mbps, or **Block**.
3. Optionally, on the **Time control** tab set the days and time window, and an allowance in minutes.
4. Save & Apply. The status section shows each rule's state (limiting, blocking, allowance left, outside time window), minutes used in the current window, collected IP addresses and dropped packets.

Notes:

- App domain lists are best effort. Apps change their domains and some use their own DNS (HTTPDNS) or hard-coded IPs, so a few requests may slip through. Add missing domains under Extra domains.
- Only minutes with real traffic (about 20 kbit/s or more) count towards the allowance. Usage is kept in RAM and starts from zero after a reboot.
- Time windows use the router's time zone (System → System). A window that crosses midnight, e.g. 22:00–07:00, is one window, so its allowance is not cleared at midnight. For a whole-day window set the same start and end time.

- Limited devices must use the router as their DNS server. Private DNS on phones or secure DNS (DoH) in browsers bypasses domain matching. You can redirect LAN port 53 to the router in the firewall.
- Software/hardware flow offloading, Turbo ACC, NSS and similar acceleration must be off, otherwise traffic bypasses the limit.
- With an IPv4 address only IPv4 traffic is limited; with a MAC address both IPv4 and IPv6 are limited.

## How it works

- dnsmasq `nftset=` adds the addresses that the target domains resolve to into nftables sets; the daemon also resolves the domains itself every 90 seconds.
- In the fw4 forward chain, connections from the target device to addresses in the set get a conntrack mark (including connections opened before the rule took effect).
- Marked traffic is limited per direction with `limit rate over … drop`, or dropped for block rules. A named counter per rule measures usage.
- Every 30 seconds the daemon checks the time window and allowance of each rule and updates the `dl_on` set of active marks atomically, so rules turn on and off without reloading the firewall.

## Building

### With the OpenWrt / ImmortalWrt SDK

```sh
# in the SDK root
echo "src-git domain_limit https://github.com/Jeremy0730/luci-app-domain-limit.git" >> feeds.conf.default
./scripts/feeds update -a
./scripts/feeds install -a
make package/luci-app-domain-limit/compile V=s
```

You can also copy the `luci-app-domain-limit/` directory into `feeds/luci/applications/` or `package/` and build it there.

### GitHub Actions

`.github/workflows/build.yml` builds apk (25.12) and ipk (24.10) packages with the ImmortalWrt SDK and generates a signed package index.

Pushing a `v*` tag (it must match `PKG_VERSION` in the Makefile, e.g. `v1.0.0`):

1. uploads the packages to a GitHub Release;
2. publishes the package feed to GitHub Pages at `https://jeremy0730.github.io/luci-app-domain-limit/`.

Repository settings required:

- **Secrets and variables → Actions** (repository secrets):
  - `APK_PRIVATE_KEY`: private key for signing the apk index (ECDSA P-256 PEM)
  - `USIGN_KEY_BUILD`: private key for signing the opkg index (usign format)
- **Pages → Build and deployment → Source**: GitHub Actions

The matching public keys are in [`keys/`](keys/). If a private key is lost, generate a new pair, replace the file in `keys/`, and ask users to import the new public key.

### Quick local build (no SDK, no translations)

```sh
python tools/build_ipk.py   # writes dist/*.ipk and dist/*.apk
```

## License

[Apache-2.0](LICENSE)
