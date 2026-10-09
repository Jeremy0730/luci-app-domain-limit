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

function deviceIds(hosts, value) {
	var ids = {};
	var v = String(value || '').trim().toLowerCase();
	var hint, mac, addrs, i;

	function add(id) {
		id = String(id || '').trim().toLowerCase();
		if (id)
			ids[id] = true;
	}

	if (!v)
		return ids;
	add(v);
	hint = hosts[v] || hosts[v.toUpperCase()] || {};
	L.toArray(hint.ipaddrs).forEach(add);
	Object.keys(hosts || {}).forEach(function(key) {
		mac = String(key).toLowerCase();
		hint = hosts[key] || {};
		addrs = L.toArray(hint.ipaddrs);
		for (i = 0; i < addrs.length; i++) {
			if (String(addrs[i]).toLowerCase() === v)
				add(mac);
		}
	});
	return ids;
}

function sameDevice(hosts, a, b) {
	var left = deviceIds(hosts, a);
	var right = deviceIds(hosts, b);
	var key;
	for (key in left) {
		if (left[key] && right[key])
			return true;
	}
	return false;
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
	if (rule.enforced) {
		if (rule.action == 'block')
			return _('Blocking');
		if (rule.stepped && rule.dl_mbps)
			return _('Limiting at %s / %s Mbps').format(rule.dl_mbps, rule.ul_mbps);
		return _('Limiting');
	}
	if (rule.window)
		return rule.stepped ? _('Not limited yet') : _('Allowance left');
	return _('Outside time window');
}

function legacyStage(section_id, n) {
	var list = L.toArray(uci.get('domain-limit', section_id, 'step'));
	var raw = list[n - 1];
	var p;
	if (raw == null || String(raw).trim() === '')
		return null;
	p = String(raw).trim().split(/\s+/);
	if (p[1] === 'block')
		return { min: p[0], action: 'block', dl: '', ul: '' };
	if (p.length >= 3)
		return { min: p[0], action: 'limit', dl: p[1], ul: p[2] };
	return { min: p[0], action: 'limit', dl: p[1], ul: p[1] };
}

function savedOrLegacy(section_id, name, n, key) {
	var saved = uci.get('domain-limit', section_id, name);
	var old;
	if (saved != null && String(saved) !== '')
		return saved;
	old = legacyStage(section_id, n);
	return (old && old[key]) ? old[key] : '';
}

function addStep(section, n) {
	var minute = section.taboption('limit', form.Value, 's' + n + '_min', _('Step %d: after (minutes)').format(n));
	var dep, act, dl, ul;
	minute.modalonly = true;
	minute.rmempty = true;
	minute.placeholder = String([ 30, 60, 90 ][n - 1]);
	minute.depends('policy', 'steps');
	if (n === 1)
		minute.description = _('Traffic is not limited before this minute. Leave a later step blank to stop the ladder. Three steps is the maximum.');
	minute.cfgvalue = function(section_id) {
		return savedOrLegacy(section_id, 's' + n + '_min', n, 'min');
	};
	minute.validate = function(section_id, value) {
		var chosen = this.section.getOption('policy').formvalue(section_id);
		var v = String(value || '').trim();
		var prev;
		if (chosen !== 'steps')
			return true;
		if (!v)
			return n === 1 ? _('The first step needs a minute.') : true;
		if (!/^\d+$/.test(v) || +v > 1440)
			return _('Minutes are 0-1440.');
		if (n > 1) {
			prev = String(this.section.getOption('s' + (n - 1) + '_min').formvalue(section_id) || '').trim();
			if (!prev)
				return _('Fill the previous step first.');
			if (+v <= +prev)
				return _('Each step must be later than the one above.');
		}
		return true;
	};

	act = section.taboption('limit', form.ListValue, 's' + n + '_action', _('Step %d: then').format(n));
	act.modalonly = true;
	act.value('limit', _('Limit speed'));
	act.value('block', _('Block'));
	act.default = 'limit';
	act.depends('policy', 'steps');
	act.cfgvalue = function(section_id) {
		return savedOrLegacy(section_id, 's' + n + '_action', n, 'action') || 'limit';
	};

	dep = { policy: 'steps' };
	dep['s' + n + '_action'] = 'limit';
	dl = section.taboption('limit', form.Value, 's' + n + '_dl', _('Step %d: download (Mbps)').format(n));
	dl.modalonly = true;
	dl.placeholder = n === 1 ? '4' : '2';
	dl.rmempty = true;
	dl.depends(dep);
	dl.cfgvalue = function(section_id) {
		return savedOrLegacy(section_id, 's' + n + '_dl', n, 'dl');
	};
	dl.validate = function(section_id, value) {
		return validStepRate(this, section_id, n, value);
	};
	ul = section.taboption('limit', form.Value, 's' + n + '_ul', _('Step %d: upload (Mbps)').format(n));
	ul.modalonly = true;
	ul.placeholder = n === 1 ? '4' : '2';
	ul.rmempty = true;
	ul.depends(dep);
	ul.cfgvalue = function(section_id) {
		return savedOrLegacy(section_id, 's' + n + '_ul', n, 'ul');
	};
	ul.validate = function(section_id, value) {
		return validStepRate(this, section_id, n, value);
	};
}

function validStepRate(option, section_id, n, value) {
	var chosen = option.section.getOption('policy').formvalue(section_id);
	var act = option.section.getOption('s' + n + '_action').formvalue(section_id);
	var mins = String(option.section.getOption('s' + n + '_min').formvalue(section_id) || '').trim();
	var v = String(value || '').trim();
	if (chosen !== 'steps' || !mins || act !== 'limit')
		return true;
	if (!/^\d+$/.test(v) || +v < 1 || +v > 10000)
		return _('Enter a rate from 1 to 10000.');
	return true;
}

function stageText(stage) {
	var label = _('%d min').format(+stage.min || 0);
	if (stage.action === 'block')
		return label + ' ' + _('Block');
	if (String(stage.dl) !== String(stage.ul))
		return label + ' ' + stage.dl + '/' + stage.ul + 'M';
	return label + ' ' + (stage.dl || '?') + 'M';
}

function formatSteps(steps) {
	return steps.map(function(raw) {
		var p = String(raw).trim().split(/\s+/);
		if (p[1] === 'block')
			return stageText({ min: p[0], action: 'block' });
		if (p.length >= 3)
			return stageText({ min: p[0], action: 'limit', dl: p[1], ul: p[2] });
		return stageText({ min: p[0], action: 'limit', dl: p[1], ul: p[1] });
	}).join(' → ');
}

function policyOf(section_id) {
	var get = function(opt) { return uci.get('domain-limit', section_id, opt); };
	var policy = get('policy');
	if (policy === 'now' || policy === 'later' || policy === 'steps')
		return policy;
	if (L.toArray(get('step')).length || (get('s1_min') != null && String(get('s1_min')) !== ''))
		return 'steps';
	if (+get('quota_min') > 0)
		return 'later';
	return 'now';
}

function actionSummary(section_id) {
	var get = function(opt) { return uci.get('domain-limit', section_id, opt); };
	var policy = policyOf(section_id);
	var quota, text, stages, i, min, legacy;
	if (policy === 'steps') {
		stages = [];
		for (i = 1; i <= 4; i++) {
			min = get('s' + i + '_min');
			if (min == null || String(min) === '')
				break;
			stages.push({
				min: min,
				action: get('s' + i + '_action') || 'limit',
				dl: get('s' + i + '_dl'),
				ul: get('s' + i + '_ul')
			});
		}
		if (stages.length)
			return stages.map(stageText).join(' → ');
		legacy = L.toArray(get('step'));
		return legacy.length ? formatSteps(legacy) : '-';
	}
	quota = +get('quota_min') || 0;
	text = get('action') === 'block'
		? _('Block')
		: _('%s / %s Mbps').format(get('dl_mbps') || '-', get('ul_mbps') || '-');
	if (policy === 'later' && quota > 0)
		return get('action') === 'block'
			? _('After %d min: Block').format(quota)
			: _('After %d min: %s / %s Mbps').format(quota, get('dl_mbps') || '-', get('ul_mbps') || '-');
	return text;
}

function renderStatus(st) {
	if (!st) {
		return E('div', { 'class': 'alert-message' },
			_('No status yet. Install and start the domain-limit service, then reopen this page.'));
	}

	var nodes = [];

	if (!st.nftset) {
		nodes.push(E('div', { 'class': 'alert-message warning' },
			_('dnsmasq was built without nftset support. Install dnsmasq-full, otherwise addresses resolved by clients are not added to the limit sets. The router still resolves the domains itself every 10 minutes.')));
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
				var cap = rule.stepped ? (rule.cap_min || 0) : (rule.quota_min || 0);
				var used = cap
					? _('%d / %d min').format(rule.used_min || 0, cap)
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
			_('One rule is one device and the apps you pick. Limit it right away, after some free minutes, or in steps. Steps are stages of that same rule. Each device can have only one rule. Rates are Mbps. example.com includes its subdomains. The device must use this router for DNS. Prefer a MAC address. With only an IPv4 address, IPv6 is not limited.'));

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
		s.description = _('Each device can have only one rule. Use steps when that device should get stricter over time.');
		s.tab('general', _('Device and apps'));
		s.tab('limit', _('Limit'));

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
		o.description = _('Select the MAC of an online device, or enter a MAC / IPv4 address. Each device can have only one rule.');
		Object.keys(hosts || {}).sort().forEach(function(key) {
			var mac = String(key).toLowerCase();
			var hint = hosts[key] || {};
			var label = mac;
			var name = hint.name || (hint.ipaddrs && hint.ipaddrs[0]) || '';
			if (name)
				label = name + ' (' + mac + ')';
			o.value(mac, label);
		});
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			var taken = null;
			if (/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(v))
				taken = false;
			else if (/^(\d{1,3}\.){3}\d{1,3}$/.test(v))
				taken = false;
			else
				return _('Enter a MAC (aa:bb:cc:dd:ee:ff) or an IPv4 address');
			uci.sections('domain-limit', 'rule').forEach(function(sec) {
				var sid = sec['.name'];
				var other, label;
				if (sid === section_id || taken)
					return;
				other = uci.get('domain-limit', sid, 'device');
				if (!sameDevice(hosts, v, other))
					return;
				label = uci.get('domain-limit', sid, 'name') || other;
				taken = label;
			});
			if (taken)
				return _('This device already has a rule (%s). Edit that rule instead of adding another.').format(taken);
			return true;
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

		o = s.option(form.DummyValue, '_action', _('Limit'));
		o.modalonly = false;
		o.cfgvalue = actionSummary;

		o = s.taboption('limit', form.ListValue, 'policy', _('How'));
		o.modalonly = true;
		o.rmempty = false;
		o.default = 'now';
		o.value('now', _('Right away'));
		o.value('later', _('Free for a while, then one limit'));
		o.value('steps', _('Tighten in steps'));
		o.description = _('Right away starts as soon as the rule is in effect. Free for a while allows normal use for the minutes below, then applies one limit or block. Tighten in steps is a ladder on this same rule: before the first step nothing is limited, then each step is stricter.');
		o.cfgvalue = function(section_id) {
			return policyOf(section_id);
		};
		o.write = function(section_id, value) {
			uci.set('domain-limit', section_id, 'policy', value);
			uci.unset('domain-limit', section_id, 'step');
		};

		o = s.taboption('limit', form.ListValue, 'action', _('Then'));
		o.modalonly = true;
		o.value('limit', _('Limit speed'));
		o.value('block', _('Block'));
		o.default = 'limit';
		o.depends('policy', 'now');
		o.depends('policy', 'later');

		o = s.taboption('limit', form.Value, 'dl_mbps', _('Download (Mbps)'));
		o.modalonly = true;
		o.datatype = 'range(1,10000)';
		o.placeholder = '4';
		o.rmempty = false;
		o.depends({ policy: 'now', action: 'limit' });
		o.depends({ policy: 'later', action: 'limit' });

		o = s.taboption('limit', form.Value, 'ul_mbps', _('Upload (Mbps)'));
		o.modalonly = true;
		o.datatype = 'range(1,10000)';
		o.placeholder = '4';
		o.rmempty = false;
		o.depends({ policy: 'now', action: 'limit' });
		o.depends({ policy: 'later', action: 'limit' });

		o = s.taboption('limit', form.Value, 'quota_min', _('Free minutes'));
		o.modalonly = true;
		o.datatype = 'range(1,1440)';
		o.placeholder = '60';
		o.rmempty = false;
		o.depends('policy', 'later');
		o.description = _('Normal use is allowed for this many minutes of real traffic. Then the action above applies. The count clears when the time window ends, or at midnight if the rule is always on.');

		for (var i = 1; i <= 3; i++)
			addStep(s, i);

		o = s.taboption('limit', form.ListValue, 'schedule', _('Hours'));
		o.modalonly = true;
		o.value('always', _('All day'));
		o.value('window', _('Only during these hours'));
		o.default = 'always';

		o = s.taboption('limit', form.MultiValue, 'weekdays', _('Days'));
		o.modalonly = true;
		WEEKDAYS.forEach(function(d) { o.value(d[0], d[1]); });
		o.default = 'mon tue wed thu fri sat sun';
		o.depends('schedule', 'window');

		o = s.taboption('limit', form.Value, 'start_time', _('From'));
		o.modalonly = true;
		o.placeholder = '22:00';
		o.rmempty = false;
		o.validate = validTime;
		o.depends('schedule', 'window');

		o = s.taboption('limit', form.Value, 'stop_time', _('To'));
		o.modalonly = true;
		o.placeholder = '07:00';
		o.rmempty = false;
		o.validate = validTime;
		o.description = _('A window that ends before it starts runs past midnight, e.g. 22:00 to 07:00. The same start and end means the whole day.');
		o.depends('schedule', 'window');

		o = s.option(form.DummyValue, '_when', _('Hours'));
		o.modalonly = false;
		o.cfgvalue = function(section_id) {
			var get = function(opt) { return uci.get('domain-limit', section_id, opt); };
			var days, names;
			if (get('schedule') != 'window')
				return _('All day');
			days = L.toArray(get('weekdays'));
			names = WEEKDAYS.filter(function(d) { return days.length == 0 || days.indexOf(d[0]) > -1; })
				.map(function(d) { return d[1]; });
			return (names.length == 7 ? _('Every day') : names.join(' ')) +
				' ' + (get('start_time') || '?') + '–' + (get('stop_time') || '?');
		};


		return Promise.all([status, m.render()]);
	}
});
