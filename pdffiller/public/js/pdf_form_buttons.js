/* Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors */

frappe.provide("pdffiller.forms");

(function () {
	"use strict";

	const SKIP_DOCTYPES = new Set(["PDF Form Template", "PDF Form Field Mapping"]);
	const cache = {};
	const DEFAULT_GROUP = __("Forms");

	function should_skip_form(frm) {
		if (!frm || !frm.doc || !frm.doctype) return true;
		if (frm.is_new() || !frm.doc.name) return true;
		if (SKIP_DOCTYPES.has(frm.doctype)) return true;
		if (frm.meta && (frm.meta.issingle || frm.meta.istable)) return true;
		return false;
	}

	function filter_templates(frm, templates) {
		return (templates || []).filter(function (template) {
			if (template.show_on_draft) return true;
			return frm.doc.docstatus === 1;
		});
	}

	function group_templates(templates) {
		const groups = {};
		templates.forEach(function (template) {
			const group_name = (template.group || "").trim() || DEFAULT_GROUP;
			if (!groups[group_name]) {
				groups[group_name] = [];
			}
			groups[group_name].push(template);
		});
		return groups;
	}

	function add_buttons(frm, templates) {
		const groups = group_templates(templates);
		Object.keys(groups)
			.sort(function (a, b) {
				if (a === DEFAULT_GROUP) return 1;
				if (b === DEFAULT_GROUP) return -1;
				return a.localeCompare(b);
			})
			.forEach(function (group_name) {
				groups[group_name].forEach(function (template) {
					frm.add_custom_button(
						template.title,
						function () {
							pdffiller.viewer.open(frm, template.name, template.title);
						},
						group_name
					);
				});
			});
	}

	function fetch_templates(frm, callback) {
		const doctype = frm.doctype;
		if (cache[doctype]) {
			callback(filter_templates(frm, cache[doctype]));
			return;
		}

		frappe.call({
			method: "pdffiller.api.forms.get_templates",
			args: { reference_doctype: doctype },
			callback(r) {
				cache[doctype] = r.message || [];
				callback(filter_templates(frm, cache[doctype]));
			},
		});
	}

	pdffiller.forms.clear_cache = function (doctype) {
		if (doctype) {
			delete cache[doctype];
			return;
		}
		Object.keys(cache).forEach(function (key) {
			delete cache[key];
		});
	};

	pdffiller.forms.add_form_buttons = function (frm) {
		if (should_skip_form(frm)) return;

		fetch_templates(frm, function (templates) {
			if (!templates.length) return;
			add_buttons(frm, templates);
		});
	};

	frappe.ui.form.on("*", {
		refresh(frm) {
			pdffiller.forms.add_form_buttons(frm);
		},
	});
})();
