/* Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors */

frappe.provide("pdffiller.forms");

(function () {
	"use strict";

	const SKIP_DOCTYPES = new Set(["PDF Form Template", "PDF Form Field Mapping"]);
	const cache = {};

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
		const grouped = {};
		const ungrouped = [];

		templates.forEach(function (template) {
			const group = (template.group || "").trim();
			if (group) {
				if (!grouped[group]) {
					grouped[group] = [];
				}
				grouped[group].push(template);
			} else {
				ungrouped.push(template);
			}
		});

		Object.keys(grouped).forEach(function (group_name) {
			grouped[group_name].sort(function (a, b) {
				return a.title.localeCompare(b.title);
			});
		});

		ungrouped.sort(function (a, b) {
			return a.title.localeCompare(b.title);
		});

		return { grouped, ungrouped };
	}

	function open_template(frm, template) {
		return function () {
			pdffiller.viewer.open(frm, template.name, template.title);
		};
	}

	function add_mobile_menu_item(frm, label, action) {
		const menu_item = frm.page.add_menu_item(label, action, false, false, false);
		menu_item.parent().addClass("hidden-xl");
		if (frm.page.menu_btn_group.hasClass("hide")) {
			frm.page.menu_btn_group.removeClass("hide").addClass("hidden-xl");
		}
	}

	function add_grouped_buttons(frm, grouped) {
		Object.keys(grouped)
			.sort(function (a, b) {
				return a.localeCompare(b);
			})
			.forEach(function (group_name) {
				const group_label = __(group_name);
				const $group = frm.page.get_or_add_inner_group_button(group_label);
				const $menu = $group.find(".dropdown-menu");
				$menu.empty();

				grouped[group_name].forEach(function (template) {
					const action = open_template(frm, template);
					add_mobile_menu_item(frm, `${group_label} > ${template.title}`, action);
					$(
						`<a class="dropdown-item" href="#" onclick="return false;" data-label="${encodeURIComponent(
							template.title
						)}">${frappe.utils.escape_html(template.title)}</a>`
					)
						.on("click", action)
						.appendTo($menu);
				});
			});
	}

	function add_buttons(frm, templates) {
		const { grouped, ungrouped } = group_templates(templates);
		$(frm.page.inner_toolbar).removeClass("hide");

		ungrouped.forEach(function (template) {
			const action = open_template(frm, template);
			add_mobile_menu_item(frm, template.title, action);
			frm.page.add_inner_button(template.title, action);
		});

		add_grouped_buttons(frm, grouped);
	}

	function cache_key(frm) {
		return `${frm.doctype}:${frm.doc.name}`;
	}

	function fetch_templates(frm, callback) {
		const key = cache_key(frm);
		if (cache[key]) {
			callback(filter_templates(frm, cache[key]));
			return;
		}

		frappe.call({
			method: "pdffiller.api.forms.get_templates",
			args: {
				reference_doctype: frm.doctype,
				name: frm.doc.name,
			},
			callback(r) {
				cache[key] = r.message || [];
				callback(filter_templates(frm, cache[key]));
			},
		});
	}

	pdffiller.forms.clear_cache = function (doctype) {
		if (doctype) {
			Object.keys(cache).forEach(function (key) {
				if (key.startsWith(`${doctype}:`)) {
					delete cache[key];
				}
			});
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
