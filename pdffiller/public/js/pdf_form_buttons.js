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

	function parse_group_path(group) {
		const trimmed = (group || "").trim();
		if (!trimmed) return [];
		return trimmed
			.split(/\s*\/\s*|\s*>\s*/)
			.map(function (part) {
				return part.trim();
			})
			.filter(Boolean);
	}

	function create_tree_node() {
		return { templates: [], children: {} };
	}

	function build_menu_tree(templates) {
		const root = create_tree_node();
		templates.forEach(function (template) {
			const path = parse_group_path(template.group);
			let node = root;
			path.forEach(function (segment) {
				if (!node.children[segment]) {
					node.children[segment] = create_tree_node();
				}
				node = node.children[segment];
			});
			node.templates.push(template);
		});
		return root;
	}

	function sort_tree_node(node) {
		node.templates.sort(function (a, b) {
			return a.title.localeCompare(b.title);
		});
		Object.keys(node.children)
			.sort(function (a, b) {
				return a.localeCompare(b);
			})
			.forEach(function (key) {
				sort_tree_node(node.children[key]);
			});
	}

	function open_template(frm, template) {
		return function () {
			pdffiller.viewer.open(frm, template.name, template.title);
		};
	}

	function add_mobile_menu_item(frm, menu_path, action) {
		const menu_item = frm.page.add_menu_item(menu_path, action, false, false, false);
		menu_item.parent().addClass("hidden-xl");
		if (frm.page.menu_btn_group.hasClass("hide")) {
			frm.page.menu_btn_group.removeClass("hide").addClass("hidden-xl");
		}
	}

	function render_menu_node(frm, $container, node, path) {
		Object.keys(node.children).forEach(function (name) {
			const child = node.children[name];
			const child_path = path.concat(name);
			const $submenu = $(
				`<li class="dropdown-submenu pdffiller-submenu">
					<a class="dropdown-item" href="#" onclick="return false;">${frappe.utils.escape_html(
						name
					)}</a>
					<ul class="dropdown-menu"></ul>
				</li>`
			);
			render_menu_node(frm, $submenu.find(".dropdown-menu"), child, child_path);
			$submenu.appendTo($container);
		});

		node.templates.forEach(function (template) {
			const menu_path = path.concat(template.title).join(" > ");
			const action = open_template(frm, template);
			add_mobile_menu_item(frm, menu_path, action);
			$(
				`<a class="dropdown-item" href="#" onclick="return false;" data-label="${encodeURIComponent(
					template.title
				)}">${frappe.utils.escape_html(template.title)}</a>`
			)
				.on("click", action)
				.appendTo($container);
		});
	}

	function add_buttons(frm, templates) {
		const tree = build_menu_tree(templates);
		sort_tree_node(tree);

		const $group = frm.page.get_or_add_inner_group_button(DEFAULT_GROUP);
		const $menu = $group.find(".dropdown-menu");
		$menu.empty();
		$(frm.page.inner_toolbar).removeClass("hide");
		render_menu_node(frm, $menu, tree, [DEFAULT_GROUP]);
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
