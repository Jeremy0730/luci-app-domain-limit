# SPDX-License-Identifier: Apache-2.0

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for per-device domain rate limit
LUCI_DESCRIPTION:=Limit the bandwidth of selected devices (by MAC or IPv4) when they access selected domains. Uses fw4/nftables and dnsmasq nftset.
LUCI_DEPENDS:=+luci-base +firewall4 +dnsmasq-full
LUCI_PKGARCH:=all

PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=Jianlong Chen

define Package/luci-app-domain-limit/conffiles
/etc/config/domain-limit
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
