'use strict';
'require view';
'require form';
'require fs';
'require poll';
'require rpc';
'require uci';

var APPS_FILE = '/usr/share/domain-limit/apps.json';

var WEEKDAYS = [
	[ 'mon', _('Mon') ], [ 'tue', _('Tue') ], [ 'wed', _('Wed') ], [ 'thu', _('Thu') ],
	[ 'fri', _('Fri') ], [ 'sat', _('Sat') ], [ 'sun', _('Sun') ]
];

var callHostHints = rpc.declare({
	object: 'luci-rpc',
	method: 'getHostHints',
	expect: { '': {} }
});

function readApps() {
	return L.resolveDefault(fs.read(APPS_FILE), '{}').then(function(text) {
		try {
			return JSON.parse(text) || {};
		} catch (e) {
			return {};
		}
	});
}

function appLabel(app, id) {
	var zh = /^zh/.test(L.env.lang || '');
	if (!app)
		return id;
	return (zh && app.name_zh) ? app.name_zh : (app.name || id);
}

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

function ruleState(rule) {
	if (!rule.enabled)
		return '-';
	if (rule.enforced)
		return rule.action == 'block' ? _('Blocking') : _('Limiting');
	if (rule.window)
		return _('Allowance left');
	return _('Outside time window');
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
			var used = rule.quota_min
				? _('%d / %d min').format(rule.used_min || 0, rule.quota_min)
				: _('%d min').format(rule.used_min || 0);
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, rule.name || rule.id),
				E('td', { 'class': 'td' }, ruleState(rule)),
				E('td', { 'class': 'td' }, used),
				E('td', { 'class': 'td' }, String(rule.v4 || 0)),
				E('td', { 'class': 'td' }, String(rule.v6 || 0)),
				E('td', { 'class': 'td' }, String(rule.up_drop || 0)),
				E('td', { 'class': 'td' }, String(rule.down_drop || 0))
			]);
		});
		nodes.push(E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('Rule')),
				E('th', { 'class': 'th' }, _('State')),
				E('th', { 'class': 'th' }, _('Used')),
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

function validTime(section, value) {
	if (!value || /^([01]?\d|2[0-3]):[0-5]\d$/.test(value))
		return true;
	return _('Use 24-hour HH:MM, e.g. 22:30');
}

return view.extend({
	load: function() {
		return Promise.all([
			callHostHints().catch(function() { return {}; }),
			readApps()
		]);
	},

	render: function(data) {
		var hosts = data[0], apps = data[1];
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
			_('Limit or block selected apps and domains for one device, optionally only at certain times or after a daily allowance. Rates are in Mbps (megabits per second). Entering example.com also covers its subdomains. Devices must use the router as DNS server; Private DNS on phones or encrypted DNS in browsers prevents domain matching. Prefer a MAC address so the rule survives IP changes. With only an IPv4 address, IPv6 traffic is not limited.'));

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
		s.tab('general', _('Rule'));
		s.tab('time', _('Time control'));

		o = s.taboption('general', form.Flag, 'enabled', _('Enabled'));
		o.default = '1';
		o.editable = true;
		o.rmempty = false;

		o = s.taboption('general', form.Value, 'name', _('Name'));
		o.placeholder = _('e.g. Living room TV');

		o = s.option(form.DummyValue, '_device', _('Device'));
		o.modalonly = false;
		o.cfgvalue = function(section_id) {
			var dev = String(uci.get('domain-limit', section_id, 'device') || '').toLowerCase();
			var hint = hosts[dev] || hosts[dev.toUpperCase()] || {};
			return hint.name ? hint.name + ' (' + dev + ')' : (dev || '-');
		};

		o = s.option(form.DummyValue, '_targets', _('Apps / domains'));
		o.modalonly = false;
		o.cfgvalue = function(section_id) {
			var names = L.toArray(uci.get('domain-limit', section_id, 'app')).map(function(id) {
				return appLabel(apps[id], id);
			});
			var extra = L.toArray(uci.get('domain-limit', section_id, 'domain')).length;
			if (extra)
				names.push(_('Domains: %d').format(extra));
			return names.length ? names.join(', ') : '-';
		};

		o = s.taboption('general', form.Value, 'device', _('Device'));
		o.modalonly = true;
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

		o = s.taboption('general', form.MultiValue, 'app', _('Apps'));
		o.modalonly = true;
		o.description = _('The domains of the selected apps are added automatically. App domain lists are best effort and are updated with the package.');
		Object.keys(apps).forEach(function(id) {
			o.value(id, appLabel(apps[id], id));
		});

		o = s.taboption('general', form.DynamicList, 'domain', _('Extra domains'));
		o.modalonly = true;
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

		o = s.taboption('general', form.ListValue, 'action', _('Action'));
		o.modalonly = true;
		o.value('limit', _('Limit speed'));
		o.value('block', _('Block'));
		o.default = 'limit';

		o = s.taboption('general', form.Value, 'dl_mbps', _('Download (Mbps)'));
		o.modalonly = true;
		o.datatype = 'range(1,10000)';
		o.default = '32';
		o.rmempty = false;
		o.depends('action', 'limit');

		o = s.taboption('general', form.Value, 'ul_mbps', _('Upload (Mbps)'));
		o.modalonly = true;
		o.datatype = 'range(1,10000)';
		o.default = '8';
		o.rmempty = false;
		o.depends('action', 'limit');

		o = s.option(form.DummyValue, '_action', _('Action'));
		o.modalonly = false;
		o.cfgvalue = function(section_id) {
			if (uci.get('domain-limit', section_id, 'action') == 'block')
				return _('Block');
			return _('%s / %s Mbps').format(
				uci.get('domain-limit', section_id, 'dl_mbps') || '-',
				uci.get('domain-limit', section_id, 'ul_mbps') || '-');
		};

		o = s.taboption('time', form.ListValue, 'schedule', _('When'));
		o.modalonly = true;
		o.value('always', _('Always'));
		o.value('window', _('Only within a time window'));
		o.default = 'always';

		o = s.taboption('time', form.MultiValue, 'weekdays', _('Days'));
		o.modalonly = true;
		WEEKDAYS.forEach(function(d) { o.value(d[0], d[1]); });
		o.default = 'mon tue wed thu fri sat sun';
		o.depends('schedule', 'window');

		o = s.taboption('time', form.Value, 'start_time', _('From'));
		o.modalonly = true;
		o.placeholder = '22:00';
		o.rmempty = false;
		o.validate = validTime;
		o.depends('schedule', 'window');

		o = s.taboption('time', form.Value, 'stop_time', _('To'));
		o.modalonly = true;
		o.placeholder = '07:00';
		o.rmempty = false;
		o.validate = validTime;
		o.description = _('A window that ends before it starts runs past midnight, e.g. 22:00 to 07:00. The same start and end means the whole day.');
		o.depends('schedule', 'window');

		o = s.taboption('time', form.Value, 'quota_min', _('Allowance (minutes)'));
		o.modalonly = true;
		o.datatype = 'range(0,1440)';
		o.placeholder = '0';
		o.description = _('Minutes the apps can be used freely within each time window before the action applies. The count starts when the window opens and is cleared when it ends; without a time window it is cleared at midnight. Only minutes with real traffic count. 0 or empty applies the action right away.');

		o = s.option(form.DummyValue, '_when', _('When'));
		o.modalonly = false;
		o.cfgvalue = function(section_id) {
			var get = function(opt) { return uci.get('domain-limit', section_id, opt); };
			var text = _('Always');
			if (get('schedule') == 'window') {
				var days = L.toArray(get('weekdays'));
				var names = WEEKDAYS.filter(function(d) { return days.length == 0 || days.indexOf(d[0]) > -1; })
					.map(function(d) { return d[1]; });
				text = (names.length == 7 ? _('Every day') : names.join(' ')) +
					' ' + (get('start_time') || '?') + '–' + (get('stop_time') || '?');
			}
			var quota = +get('quota_min') || 0;
			if (quota > 0)
				text += ', ' + (get('schedule') == 'window'
					? _('after %d min per window').format(quota)
					: _('after %d min/day').format(quota));
			return text;
		};

		return Promise.all([status, m.render()]);
	}
});
