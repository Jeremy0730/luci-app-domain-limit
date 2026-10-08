'use strict';
'require view';
'require form';
'require fs';
'require poll';
'require rpc';

var callHostHints = rpc.declare({
	object: 'luci-rpc',
	method: 'getHostHints',
	expect: { '': {} }
});

function readStatus() {
	return fs.exec('/usr/sbin/domain-limit-status', []).then(function(res) {
		var out = (res && res.stdout) ? String(res.stdout).trim() : '';
		if (!out)
			return null;
		try {
			return JSON.parse(out);
		} catch (e) {
			return null;
		}
	}, function() {
		return null;
	});
}

function renderStatus(st) {
	if (!st) {
		return E('div', { 'class': 'alert-message' },
			_('No status yet. Install and start the domain-limit service, then reopen this page.'));
	}

	var nodes = [];

	if (!st.nftset) {
		nodes.push(E('div', { 'class': 'alert-message warning' },
			_('dnsmasq was built without nftset support. Install dnsmasq-full, otherwise addresses resolved by clients are not added to the limit sets. The router still resolves the domains itself every 90 seconds.')));
	}

	if (st.auto_includes === 0) {
		nodes.push(E('div', { 'class': 'alert-message warning' },
			_('Automatic loading of nftables includes (auto_includes) is disabled in the firewall. The rules on this page will not reach the forward path.')));
	}

	if (st.flow_offloading || st.flow_offloading_hw) {
		nodes.push(E('div', { 'class': 'alert-message warning' },
			_('Flow offloading is enabled and bypasses the limit. Disable software and hardware flow offloading under Network → Firewall. If the device has Turbo ACC, fast forwarding or NSS acceleration, disable those as well.')));
	}

	if (!st.active) {
		nodes.push(E('p', {}, _('The limit is not active yet. Turn on the main switch, add at least one rule, then save and apply.')));
	}

	var rules = st.rules || [];
	if (rules.length) {
		var rows = rules.map(function(rule) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, rule.name || rule.id),
				E('td', { 'class': 'td' }, rule.enabled ? _('Yes') : _('No')),
				E('td', { 'class': 'td' }, String(rule.v4 || 0)),
				E('td', { 'class': 'td' }, String(rule.v6 || 0)),
				E('td', { 'class': 'td' }, String(rule.up_drop || 0)),
				E('td', { 'class': 'td' }, String(rule.down_drop || 0))
			]);
		});
		nodes.push(E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('Rule')),
				E('th', { 'class': 'th' }, _('Enabled')),
				E('th', { 'class': 'th' }, _('IPv4 addresses')),
				E('th', { 'class': 'th' }, _('IPv6 addresses')),
				E('th', { 'class': 'th' }, _('Upload drops')),
				E('th', { 'class': 'th' }, _('Download drops'))
			])
		].concat(rows)));
		nodes.push(E('p', {}, _('If the address count is 0, the device is probably still using its own DNS cache. Reconnect it, or wait for the cache to expire, then visit the site again.')));
	}

	return E('div', {}, nodes);
}

return view.extend({
	load: function() {
		return callHostHints().catch(function() { return {}; });
	},

	render: function(hosts) {
		var body = E('div', {}, _('Loading…'));
		var status = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Current status')),
			body
		]);

		poll.add(function() {
			return readStatus().then(function(st) {
				while (body.firstChild)
					body.removeChild(body.firstChild);
				body.appendChild(renderStatus(st));
			});
		}, 5);

		var m, s, o;

		m = new form.Map('domain-limit', _('Domain Rate Limit'),
			_('Limit the speed of one device when it accesses the listed domains; other sites are not affected. Rates are in Mbps (megabits per second). Entering example.com also covers its subdomains. Devices must use the router as DNS server; Private DNS on phones or encrypted DNS in browsers prevents domain matching. Prefer a MAC address so the rule survives IP changes. With only an IPv4 address, IPv6 traffic is not limited.'));

		s = m.section(form.NamedSection, 'global', 'global', _('Main switch'));

		o = s.option(form.Flag, 'enabled', _('Enable'));
		o.rmempty = false;
		o.default = '0';

		o = s.option(form.Value, 'lan_if', _('LAN device'));
		o.placeholder = 'br-lan';
		o.rmempty = true;
		o.description = _('Leave empty to use the device of interface lan, usually br-lan.');
		o.validate = function(section, value) {
			if (!value)
				return true;
			if (!/^[A-Za-z][A-Za-z0-9._-]{0,14}$/.test(value))
				return _('Device names may contain only letters, digits, dots, underscores and hyphens');
			return true;
		};

		s = m.section(form.GridSection, 'rule', _('Rules'));
		s.anonymous = true;
		s.addremove = true;
		s.sortable = true;

		o = s.option(form.Flag, 'enabled', _('Enabled'));
		o.default = '1';
		o.editable = true;
		o.rmempty = false;

		o = s.option(form.Value, 'name', _('Name'));
		o.placeholder = _('e.g. Living room TV');

		o = s.option(form.Value, 'device', _('Device'));
		o.rmempty = false;
		o.description = _('Select the MAC of an online device, or enter a MAC / IPv4 address.');
		Object.keys(hosts || {}).sort().forEach(function(key) {
			var mac = String(key).toLowerCase();
			var hint = hosts[key] || {};
			var label = mac;
			var name = hint.name || (hint.ipaddrs && hint.ipaddrs[0]) || '';
			if (name)
				label = name + ' (' + mac + ')';
			o.value(mac, label);
		});
		o.validate = function(section, value) {
			var v = String(value || '').trim();
			if (/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(v))
				return true;
			if (/^(\d{1,3}\.){3}\d{1,3}$/.test(v))
				return true;
			return _('Enter a MAC (aa:bb:cc:dd:ee:ff) or an IPv4 address');
		};

		o = s.option(form.DynamicList, 'domain', _('Domains'));
		o.rmempty = false;
		o.placeholder = 'example.com';
		o.description = _('Type the domain and click Save; there is no need to click the plus button first. Do not include the protocol or path. Enter internationalized domains in punycode (starting with xn--).');
		o.validate = function(section, value) {
			// The list box is a div and has no .value, so LuCI validates it as "".
			// Rejecting that marks the whole field invalid and the modal Save does nothing.
			var d = String(value || '').trim().replace(/^\*\./, '').replace(/\.+$/, '');
			if (!d)
				return true;
			if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(d))
				return _('Invalid domain, e.g. example.com');
			return true;
		};

		o = s.option(form.Value, 'dl_mbps', _('Download (Mbps)'));
		o.datatype = 'range(1,10000)';
		o.default = '32';
		o.rmempty = false;

		o = s.option(form.Value, 'ul_mbps', _('Upload (Mbps)'));
		o.datatype = 'range(1,10000)';
		o.default = '8';
		o.rmempty = false;

		return Promise.all([status, m.render()]);
	}
});
