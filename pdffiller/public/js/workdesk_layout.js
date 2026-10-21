/* Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors */

frappe.provide("pdffiller.workdesk");

(function () {
	"use strict";

	const STORAGE_KEY = "pdffiller.workdesk_layout";
	const LAYOUT_FIELDS = new Set(["Section Break", "Column Break", "Tab Break", "Fold"]);
	const TABLE_FIELDS = new Set(["Table", "Table MultiSelect"]);

	const state = {
		open: localStorage.getItem(STORAGE_KEY) !== "0",
		tab: "layout",
		refKind: "child",
		query: "",
		expanded: {},
		selectedId: null,
		frm: null,
		tree: [],
	};

	let badge = null;
	let highlighted = null;

	function esc(value) {
		return frappe.utils.escape_html(value == null ? "" : String(value));
	}

	function icon(name) {
		return frappe.utils.icon(name || "edit", "xs");
	}

	function fieldIcon(fieldtype) {
		const icons = {
			Link: "link",
			"Dynamic Link": "link",
			Date: "calendar",
			Datetime: "calendar",
			Time: "calendar",
			Currency: "hash",
			Float: "hash",
			Int: "hash",
			Percent: "hash",
			Check: "check",
			Select: "list",
			Table: "table_2",
			"Small Text": "text",
			Text: "text",
			"Long Text": "text",
			"Text Editor": "text",
		};
		return icons[fieldtype] || "edit";
	}

	function isHidden(field) {
		if (!field) return true;
		const df = field.df || field;
		if (df.hidden || df.fieldname === "__newname") return true;
		const wrapper = field.$wrapper;
		if (wrapper && wrapper.hasClass("hide-control")) return true;
		if (field.disp_status === "None") return true;
		return false;
	}

	function sectionIsVisible(section) {
		if (!section || !section.df || section.df.is_dashboard_section) return false;
		if (section.wrapper && section.wrapper.hasClass("hide-control")) return false;
		return true;
	}

	function fieldNode(field, section) {
		const df = field.df;
		return {
			id: `field:${df.fieldname}`,
			label: __(df.label || df.fieldname),
			icon: fieldIcon(df.fieldtype),
			kind: "field",
			fieldname: df.fieldname,
			sectionFieldname: section && section.df ? section.df.fieldname : "",
			children: [],
		};
	}

	function sectionNode(section) {
		const fields = (section.fields_list || []).filter((field) => {
			const df = field && field.df;
			if (!df || LAYOUT_FIELDS.has(df.fieldtype) || TABLE_FIELDS.has(df.fieldtype)) return false;
			return !isHidden(field);
		});
		if (!section.df.label && !fields.length) return null;
		const label = section.df.label
			? `${__("Section")}: ${__(section.df.label)}`
			: __("Section");
		return {
			id: `section:${section.df.fieldname}`,
			label,
			icon: "list",
			kind: "section",
			sectionFieldname: section.df.fieldname,
			open: false,
			children: fields.map((field) => fieldNode(field, section)),
		};
	}

	function tabForSection(section, tabs) {
		if (!section.wrapper) return null;
		const pane = section.wrapper.closest(".tab-pane");
		if (!pane.length) return null;
		return (
			tabs.find((tab) => tab.wrapper && tab.wrapper.attr("id") === pane.attr("id")) || null
		);
	}

	function childTableNodes(frm) {
		return (frm.meta.fields || [])
			.filter((df) => df.fieldtype === "Table" && df.fieldname)
			.filter((df) => {
				const field = frm.get_field(df.fieldname);
				return field && !isHidden(field);
			})
			.map((df) => {
				const field = frm.get_field(df.fieldname);
				return {
					id: `table:${df.fieldname}`,
					label: __(df.label || df.fieldname),
					icon: "table_2",
					kind: "table",
					fieldname: df.fieldname,
					sectionFieldname: field.section && field.section.df ? field.section.df.fieldname : "",
					options: df.options,
					children: [],
				};
			});
	}

	function buildTree(frm) {
		const tabs = (frm.layout.tabs || []).filter((tab) => tab && !tab.hidden);
		const sections = (frm.layout.sections || []).filter(sectionIsVisible);
		const grouped = new Map();
		const loose = [];

		sections.forEach((section) => {
			const node = sectionNode(section);
			if (!node) return;
			const tab = tabForSection(section, tabs);
			if (tabs.length > 1 && tab) {
				if (!grouped.has(tab)) grouped.set(tab, []);
				grouped.get(tab).push(node);
				return;
			}
			loose.push(node);
		});

		const mainChildren = [];
		grouped.forEach((sectionNodes, tab) => {
			mainChildren.push({
				id: `tab:${tab.df.fieldname}`,
				label: __(tab.df.label || tab.label || tab.df.fieldname),
				icon: "list",
				kind: "tab",
				tabFieldname: tab.df.fieldname,
				open: true,
				children: sectionNodes,
			});
		});
		mainChildren.push(...loose);

		const tables = childTableNodes(frm);

		return [
			{
				id: "page",
				label: __("Page"),
				icon: "file-large",
				kind: "page",
				open: true,
				children: [
					{
						id: "header",
						label: __("Header"),
						icon: "header",
						kind: "header",
						open: true,
						children: [
							{
								id: "header:title",
								label: __("Title"),
								icon: "text",
								kind: "title",
								children: [],
							},
							{
								id: "header:status",
								label: __("Status"),
								icon: "unread-status",
								kind: "status",
								children: [],
							},
							{
								id: "header:actions",
								label: __("Actions"),
								icon: "tool",
								kind: "actions",
								children: [],
							},
						],
					},
					{
						id: "main",
						label: __("Main"),
						icon: "columns-2",
						kind: "main",
						open: true,
						children: mainChildren,
					},
					{
						id: "childtables",
						label: __("Child Tables"),
						icon: "table_2",
						kind: "childtables",
						open: true,
						children: tables,
					},
				],
			},
		];
	}

	function findNode(nodes, id) {
		for (const node of nodes || []) {
			if (node.id === id) return node;
			const found = findNode(node.children, id);
			if (found) return found;
		}
		return null;
	}

	function matches(node, query) {
		const hay = `${node.label || ""} ${node.fieldname || ""} ${node.columnFieldname || ""}`.toLowerCase();
		return hay.includes(query);
	}

	function filterNodes(nodes, query) {
		if (!query) return nodes;
		const out = [];
		nodes.forEach((node) => {
			const self = matches(node, query);
			const children = self ? node.children || [] : filterNodes(node.children || [], query);
			if (self || children.length) {
				out.push(Object.assign({}, node, { children, forceOpen: true }));
			}
		});
		return out;
	}

	function isOpen(node) {
		if (node.forceOpen) return true;
		if (Object.prototype.hasOwnProperty.call(state.expanded, node.id)) {
			return !!state.expanded[node.id];
		}
		return !!node.open;
	}

	function elementFor(frm, node) {
		if (!frm || !node) return null;
		if (node.kind === "title") return frm.page.wrapper.find(".title-area .page-title").get(0);
		if (node.kind === "status") return frm.page.indicator && frm.page.indicator.get(0);
		if (node.kind === "actions") return frm.page.page_actions && frm.page.page_actions.get(0);
		if (node.kind === "header") return frm.page.page_head && frm.page.page_head.get(0);
		if (node.kind === "page" || node.kind === "main") {
			return frm.layout.page && frm.layout.page.get(0);
		}
		if (node.kind === "tab") {
			const tab = (frm.layout.tabs || []).find((item) => item.df.fieldname === node.tabFieldname);
			return tab && tab.wrapper && tab.wrapper.get(0);
		}
		if (node.kind === "section") {
			const section = frm.layout.sections_dict[node.sectionFieldname];
			return section && section.wrapper && section.wrapper.get(0);
		}
		if (node.kind === "field" || node.kind === "table" || node.kind === "column") {
			const field = frm.get_field(node.fieldname);
			if (!field || !field.$wrapper) return null;
			if (node.kind === "column" && field.grid && node.columnFieldname) {
				const column = field.grid.wrapper
					.find(
						`.grid-heading-row [data-fieldname="${node.columnFieldname}"], .grid-static-col[data-fieldname="${node.columnFieldname}"]`
					)
					.get(0);
				if (column) return column;
			}
			return field.$wrapper.get(0);
		}
		return null;
	}

	function reveal(frm, el) {
		if (!el) return;
		const $el = $(el);
		const pane = $el.closest(".tab-pane");
		if (pane.length && frm.layout) {
			const tab = (frm.layout.tabs || []).find(
				(item) => item.wrapper && item.wrapper.attr("id") === pane.attr("id")
			);
			if (tab && typeof tab.is_active === "function" && !tab.is_active()) {
				tab.set_active();
			}
		}
		const sectionWrap = $el.closest(".form-section");
		if (sectionWrap.length && frm.layout) {
			const section = (frm.layout.sections || []).find(
				(item) => item.wrapper && item.wrapper[0] === sectionWrap[0]
			);
			if (section && section.body && section.body.hasClass("hide")) {
				section.collapse(false);
			}
		}
	}

	function ensureBadge() {
		if (badge) return badge;
		badge = document.createElement("div");
		badge.className = "wd-highlight-badge";
		badge.textContent = __("Highlighted on Workdesk");
		badge.hidden = true;
		document.body.appendChild(badge);
		return badge;
	}

	function placeBadge(el) {
		const mark = ensureBadge();
		const rect = el.getBoundingClientRect();
		if (!rect.width && !rect.height) {
			mark.hidden = true;
			return;
		}
		mark.hidden = false;
		mark.style.left = `${rect.left + rect.width / 2}px`;
		mark.style.top = `${Math.max(rect.top, 8)}px`;
	}

	function onViewportChange() {
		if (!highlighted || !highlighted.isConnected) {
			clearHighlight();
			return;
		}
		placeBadge(highlighted);
	}

	function clearHighlight() {
		document.querySelectorAll(".wd-highlight").forEach((el) => el.classList.remove("wd-highlight"));
		highlighted = null;
		if (badge) badge.hidden = true;
		window.removeEventListener("scroll", onViewportChange, true);
		window.removeEventListener("resize", onViewportChange);
	}

	function showHighlight(node, options) {
		const frm = state.frm;
		const scroll = !!(options && options.scroll);
		if (!frm || !node) return;
		let el = elementFor(frm, node);
		if (!el) {
			if (scroll) clearHighlight();
			return;
		}
		if (scroll) {
			reveal(frm, el);
			el = elementFor(frm, node) || el;
		}
		clearHighlight();
		el.classList.add("wd-highlight");
		highlighted = el;
		placeBadge(el);
		window.addEventListener("scroll", onViewportChange, true);
		window.addEventListener("resize", onViewportChange);
		if (scroll) {
			el.scrollIntoView({ behavior: "smooth", block: "center" });
			window.setTimeout(onViewportChange, 350);
		}
	}

	function renderNodes(nodes, depth) {
		return (nodes || [])
			.map((node) => {
				const children = node.children || [];
				const open = children.length && isOpen(node);
				const selected = node.id === state.selectedId ? " is-selected" : "";
				const childHtml = open ? renderNodes(children, depth + 1) : "";
				const chevron = children.length
					? `<span class="wd-chevron${open ? " is-open" : ""}" data-chevron="1"></span>`
					: `<span class="wd-chevron is-leaf"></span>`;
				return `<div class="wd-node-wrap">
					<button type="button" class="wd-node${selected}" data-id="${esc(node.id)}" style="padding-left:${
						8 + depth * 16
					}px" aria-expanded="${children.length ? (open ? "true" : "false") : "false"}">
						${chevron}
						<span class="wd-node-icon">${icon(node.icon)}</span>
						<span class="wd-node-label">${esc(node.label)}</span>
					</button>
					${childHtml}
				</div>`;
			})
			.join("");
	}

	function columnFields(doctype) {
		if (!doctype || !locals.DocType[doctype]) return [];
		const meta = frappe.get_meta(doctype);
		if (!meta) return [];
		return (meta.fields || []).filter((df) => {
			if (!df.fieldname || df.hidden) return false;
			return frappe.model.no_value_type.indexOf(df.fieldtype) === -1;
		});
	}

	function documentFields(frm) {
		const fields = [];
		(frm.layout.sections || []).filter(sectionIsVisible).forEach((section) => {
			(section.fields_list || []).forEach((field) => {
				const df = field && field.df;
				if (!df || LAYOUT_FIELDS.has(df.fieldtype) || TABLE_FIELDS.has(df.fieldtype)) return;
				if (isHidden(field)) return;
				fields.push(df);
			});
		});
		return fields;
	}

	function refCard(df, tableFieldname) {
		const id = tableFieldname
			? `column:${tableFieldname}:${df.fieldname}`
			: `field:${df.fieldname}`;
		const selected = id === state.selectedId ? " is-selected" : "";
		const meta = tableFieldname ? `${tableFieldname}.${df.fieldname}` : df.fieldname;
		return `<button type="button" class="wd-ref-field${selected}" data-id="${esc(id)}">
			<span class="wd-ref-name">${esc(__(df.label || df.fieldname))}</span>
			<span class="wd-ref-meta">${esc(meta)}</span>
		</button>`;
	}

	function refGroup(id, label, count, body, openDefault) {
		const open = Object.prototype.hasOwnProperty.call(state.expanded, id)
			? !!state.expanded[id]
			: !!openDefault;
		return `<div class="wd-ref-group${open ? " is-open" : ""}" data-group="${esc(id)}">
			<button type="button" class="wd-ref-toggle" aria-expanded="${open ? "true" : "false"}">
				<span class="wd-chevron${open ? " is-open" : ""}"></span>
				<span class="wd-ref-group-label">${esc(label)}</span>
				<span class="wd-ref-count">${count}</span>
			</button>
			<div class="wd-ref-body">${body || `<div class="wd-empty">${esc(__("No columns"))}</div>`}</div>
		</div>`;
	}

	function renderReference(frm, query) {
		const kind = state.refKind || "child";
		const viewSelect = `<select class="wd-ref-view" aria-label="${esc(__("Reference view"))}">
			<option value="child" ${kind === "child" ? "selected" : ""}>${esc(__("Child Tables"))}</option>
			<option value="document" ${kind === "document" ? "selected" : ""}>${esc(__("Document Fields"))}</option>
		</select>`;
		if (kind === "document") {
			const docs = documentFields(frm).filter((df) => {
				if (!query) return true;
				return `${df.label || ""} ${df.fieldname}`.toLowerCase().includes(query);
			});
			const cards = docs.map((df) => refCard(df)).join("");
			return `${viewSelect}<div class="wd-ref-list">${
				cards || `<div class="wd-empty">${esc(__("No matching fields."))}</div>`
			}</div>`;
		}
		const tables = childTableNodes(frm);
		let html = "";
		tables.forEach((table) => {
			let columns = columnFields(table.options);
			if (query) {
				columns = columns.filter((df) =>
					`${df.label || ""} ${df.fieldname} ${table.label}`.toLowerCase().includes(query)
				);
				if (!columns.length && !table.label.toLowerCase().includes(query)) return;
			}
			html += refGroup(
				`ref:${table.fieldname}`,
				table.label,
				columns.length,
				columns.map((df) => refCard(df, table.fieldname)).join(""),
				false
			);
		});
		return `${viewSelect}<div class="wd-ref-list">${
			html || `<div class="wd-empty">${esc(__("No child tables on this form."))}</div>`
		}</div>`;
	}

	function renderBody(root) {
		const frm = state.frm;
		if (!frm || !root || !root.length) return;
		const query = (state.query || "").trim().toLowerCase();
		const body = root.find(".wd-body");
		root.toggleClass("is-fields", state.tab === "fields");
		root.find(".wd-title").text(state.tab === "fields" ? __("Reference Fields") : __("Workdesk Layout"));
		root.find(".wd-tab").each(function () {
			$(this).toggleClass("is-active", this.dataset.tab === state.tab);
		});
		if (state.tab === "fields") {
			body.html(renderReference(frm, query));
			return;
		}
		state.tree = buildTree(frm);
		const visible = filterNodes(state.tree, query);
		const html = renderNodes(visible, 0);
		body.html(html || `<div class="wd-empty">${esc(__("No matching objects."))}</div>`);
	}

	function expandAncestors(id) {
		function walk(nodes, parents) {
			for (const node of nodes || []) {
				if (node.id === id) {
					parents.forEach((parent) => {
						state.expanded[parent.id] = true;
					});
					return true;
				}
				if (walk(node.children, parents.concat(node))) return true;
			}
			return false;
		}
		walk(state.tree, []);
	}

	function selectNode(node, scroll) {
		if (!node) return;
		state.selectedId = node.id;
		if (!state.tree.length && state.frm) state.tree = buildTree(state.frm);
		expandAncestors(node.id);
		if (node.kind === "column" && node.fieldname) {
			state.expanded[`ref:${node.fieldname}`] = true;
			state.refKind = "child";
		}
		const root = sidebarRoot();
		if (root) renderBody(root);
		showHighlight(node, { scroll: !!scroll });
	}

	function nodeFromReference(id) {
		if (!id) return null;
		if (id.startsWith("field:")) {
			return findNode(state.tree, id) || { id, kind: "field", fieldname: id.slice(6) };
		}
		if (id.startsWith("column:")) {
			const parts = id.split(":");
			return {
				id,
				kind: "column",
				fieldname: parts[1],
				columnFieldname: parts.slice(2).join(":"),
			};
		}
		return findNode(state.tree, id);
	}

	function sidebarRoot() {
		if (!state.frm || !state.frm.page) return null;
		const root = state.frm.page.wrapper.find(".layout-main > .wd-layout");
		return root.length ? root : null;
	}

	function ensureChildMeta(frm, done) {
		const missing = childTableNodes(frm)
			.map((table) => table.options)
			.filter((doctype) => doctype && !locals.DocType[doctype]);
		if (!missing.length) {
			done();
			return;
		}
		let pending = missing.length;
		missing.forEach((doctype) => {
			frappe.model.with_doctype(doctype, () => {
				pending -= 1;
				if (pending === 0 && state.frm === frm) done();
			});
		});
	}

	function bindSidebar(root) {
		root.on("change", ".wd-ref-view", function () {
			state.refKind = this.value === "document" ? "document" : "child";
			renderBody(root);
		});
		root.on("click", ".wd-tab", function () {
			state.tab = this.dataset.tab;
			if (state.tab === "fields") {
				ensureChildMeta(state.frm, () => renderBody(root));
				return;
			}
			renderBody(root);
		});
		root.on("click", ".wd-close", () => {
			if (state.frm) setOpen(state.frm, false);
		});
		root.on("input", ".wd-search", function () {
			state.query = this.value;
			renderBody(root);
		});
		root.on("click", ".wd-node", function (event) {
			const id = this.dataset.id;
			const node = findNode(state.tree, id);
			if (!node) return;
			if (event.target.closest("[data-chevron]") && (node.children || []).length) {
				state.expanded[node.id] = !isOpen(node);
				renderBody(root);
				return;
			}
			selectNode(node, true);
		});
		root.on("mouseenter", ".wd-node", function () {
			const node = findNode(state.tree, this.dataset.id);
			if (!node || node.id === state.selectedId) return;
			showHighlight(node, { scroll: false });
		});
		root.on("mouseleave", ".wd-node", function () {
			if (this.dataset.id === state.selectedId) return;
			const selected = nodeFromReference(state.selectedId);
			if (selected) showHighlight(selected, { scroll: false });
			else clearHighlight();
		});
		root.on("click", ".wd-ref-toggle", function () {
			const group = $(this).closest(".wd-ref-group");
			const id = group.attr("data-group");
			const open = !group.hasClass("is-open");
			state.expanded[id] = open;
			group.toggleClass("is-open", open);
			$(this).attr("aria-expanded", open ? "true" : "false");
			$(this).find(".wd-chevron").toggleClass("is-open", open);
		});
		root.on("click", ".wd-ref-field", function () {
			if (!state.tree.length && state.frm) state.tree = buildTree(state.frm);
			selectNode(nodeFromReference(this.dataset.id), true);
		});
		root.on("mouseenter", ".wd-ref-field", function () {
			if (this.dataset.id === state.selectedId) return;
			if (!state.tree.length && state.frm) state.tree = buildTree(state.frm);
			showHighlight(nodeFromReference(this.dataset.id), { scroll: false });
		});
		root.on("mouseleave", ".wd-ref-field", function () {
			if (this.dataset.id === state.selectedId) return;
			const selected = nodeFromReference(state.selectedId);
			if (selected) showHighlight(selected, { scroll: false });
			else clearHighlight();
		});
	}

	function mount(frm) {
		const main = frm.page.wrapper.find(".layout-main");
		if (!main.length) return;
		main.addClass("wd-layout-active");
		main.children(".layout-side-section").addClass("wd-native-side-hidden");
		let root = main.children(".wd-layout");
		if (!root.length) {
			root = $(`
				<aside class="wd-layout">
					<div class="wd-tabs">
						<button type="button" class="wd-tab is-active" data-tab="layout">
							${icon("columns-2")}
							<span>${esc(__("Layout"))}</span>
						</button>
						<button type="button" class="wd-tab" data-tab="fields">
							${icon("list")}
							<span>${esc(__("Reference Fields"))}</span>
						</button>
					</div>
					<div class="wd-head">
						<div class="wd-title">${esc(__("Workdesk Layout"))}</div>
						<button type="button" class="wd-close" aria-label="${esc(__("Close"))}">&times;</button>
					</div>
					<label class="wd-search-wrap">
						<span class="wd-search-icon">${icon("search")}</span>
						<input type="search" class="wd-search" placeholder="${esc(__("Search objects..."))}" value="${esc(
							state.query
						)}" />
					</label>
					<div class="wd-body"></div>
				</aside>
			`);
			main.prepend(root);
			bindSidebar(root);
		}
		state.frm = frm;
		const finish = () => renderBody(root);
		if (state.tab === "fields") ensureChildMeta(frm, finish);
		else finish();
		if (state.selectedId) {
			const node = nodeFromReference(state.selectedId);
			if (node) showHighlight(node, { scroll: false });
		}
	}

	function unmount(frm) {
		clearHighlight();
		const page = frm && frm.page && frm.page.wrapper;
		if (!page) return;
		const main = page.find(".layout-main");
		main.removeClass("wd-layout-active");
		main.children(".layout-side-section").removeClass("wd-native-side-hidden");
		main.children(".wd-layout").remove();
	}

	function setToggle(frm) {
		const button = frm.page.wrapper.find(".wd-layout-toggle");
		button.toggleClass("is-active", state.open);
	}

	function setOpen(frm, open) {
		state.open = !!open;
		localStorage.setItem(STORAGE_KEY, state.open ? "1" : "0");
		if (state.open) mount(frm);
		else unmount(frm);
		setToggle(frm);
	}

	function toggle(frm) {
		setOpen(frm, !state.open);
	}

	function shouldSkip(frm) {
		if (!frm || !frm.doc || !frm.doctype || !frm.layout || !frm.page) return true;
		if (frm.meta && frm.meta.istable) return true;
		if (frm.$wrapper && frm.$wrapper.closest(".modal").length) return true;
		return false;
	}

	function isDesignDocument(frm) {
		return frm && (frm.doctype === "PDF Form Template" || frm.doctype === "PDF Print Design");
	}

	pdffiller.workdesk.refresh = function (frm) {
		if (shouldSkip(frm)) return;
		if (isDesignDocument(frm)) {
			unmount(frm);
			frm.page.wrapper.find(".wd-layout-toggle").remove();
			return;
		}
		const button = frm.page.add_inner_button(__("Layout"), () => toggle(frm));
		if (button) button.addClass("wd-layout-toggle").toggleClass("is-active", state.open);
		state.frm = frm;
		if (state.open) mount(frm);
		else unmount(frm);
	};

	frappe.ui.form.on("*", {
		refresh(frm) {
			pdffiller.workdesk.refresh(frm);
		},
	});
})();
