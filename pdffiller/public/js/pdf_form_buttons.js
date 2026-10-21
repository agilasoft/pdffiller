/* Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors */

frappe.provide("pdffiller.forms");

(function () {
	"use strict";

	const SKIP_DOCTYPES = new Set([
		"PDF Form Template",
		"PDF Form Field Mapping",
		"PDF Print Design",
		"PDF Form Packet",
		"PDF Form Packet Item",
		"PDF Form Generation Log",
		"PDF Form Allowed Role",
		"PDF Filler AI Settings",
		"PDF Filler AI Allowed Role",
	]);
	const cache = {};

	function doctype_may_have_forms(doctype) {
		const known = frappe.boot && frappe.boot.pdffiller_reference_doctypes;
		if (!Array.isArray(known)) return true;
		return known.indexOf(doctype) !== -1;
	}

	function should_skip_form(frm) {
		if (!frm || !frm.doc || !frm.doctype) return true;
		if (frm.is_new() || !frm.doc.name) return true;
		if (SKIP_DOCTYPES.has(frm.doctype)) return true;
		if (!doctype_may_have_forms(frm.doctype)) return true;
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
			pdffiller.viewer.open(frm, template.name, template.title, template.source);
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

	function download_file(data_uri, filename) {
		const link = document.createElement("a");
		link.href = data_uri;
		link.download = filename || "forms.pdf";
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	}

	function bulk_generate(listview, template) {
		const names = (listview.get_checked_items() || []).map(function (row) {
			return row.name;
		});
		if (!names.length) {
			frappe.msgprint(__("Select at least one document."));
			return;
		}
		const dialog = new frappe.ui.Dialog({
			title: template.title,
			fields: [
				{
					fieldtype: "Select",
					fieldname: "output",
					label: __("Download as"),
					options: ["Merged PDF", "Zip of PDFs"].join("\n"),
					default: "Merged PDF",
				},
			],
			primary_action_label: __("Download"),
			primary_action(values) {
				dialog.hide();
				frappe.call({
					method: "pdffiller.api.forms.bulk_generate",
					args: {
						reference_doctype: listview.doctype,
						names: JSON.stringify(names),
						template: template.name,
						source: template.source,
						output: values.output === "Zip of PDFs" ? "zip" : "merged",
					},
					freeze: true,
					callback(r) {
						if (!r.message || !r.message.data_uri) return;
						if (r.message.warnings && r.message.warnings.length) {
							frappe.msgprint({
								title: __("Some values could not be filled"),
								indicator: "orange",
								message: r.message.warnings
									.map(function (warning) {
										return frappe.utils.escape_html(
											`${warning.field || ""}: ${warning.message || ""}`
										);
									})
									.join("<br>"),
							});
						}
						download_file(r.message.data_uri, r.message.filename);
					},
				});
			},
		});
		dialog.show();
	}

	pdffiller.forms.add_list_actions = function (listview) {
		if (!listview || !listview.doctype || !listview.page) return;
		if (SKIP_DOCTYPES.has(listview.doctype)) return;
		if (listview.pdffiller_bulk_ready) return;
		if (!doctype_may_have_forms(listview.doctype)) return;
		listview.pdffiller_bulk_ready = true;

		frappe.call({
			method: "pdffiller.api.forms.get_templates",
			args: { reference_doctype: listview.doctype },
			callback(r) {
				const templates = r.message || [];
				if (!templates.length) return;
				templates.forEach(function (template) {
					listview.page.add_inner_button(template.title, function () {
						bulk_generate(listview, template);
					}, __("PDF Forms"));
				});
			},
		});
	};

	function install_list_hook() {
		if (!frappe.views || !frappe.views.ListView) return;
		if (frappe.views.ListView.prototype.__pdffiller_hooked) return;
		const original = frappe.views.ListView.prototype.refresh;
		frappe.views.ListView.prototype.refresh = function () {
			const result = original.apply(this, arguments);
			const listview = this;
			Promise.resolve(result).then(function () {
				pdffiller.forms.add_list_actions(listview);
			});
			return result;
		};
		frappe.views.ListView.prototype.__pdffiller_hooked = true;
	}

	install_list_hook();

	frappe.ui.form.on("*", {
		refresh(frm) {
			pdffiller.forms.add_form_buttons(frm);
		},
	});
})();
