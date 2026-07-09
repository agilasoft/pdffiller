/* Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors */

frappe.provide("pdffiller.designer");

(function () {
	"use strict";

	const FIELD_TYPES = [
		{ type: "Data", icon: "text", label: __("Data"), width: 150, height: 20, font_size: 10 },
		{ type: "Link", icon: "link", label: __("Link"), width: 150, height: 20, font_size: 10 },
		{ type: "Date", icon: "calendar", label: __("Date"), width: 100, height: 20, font_size: 10, date_format: "%d-%m-%Y" },
		{ type: "Int", icon: "hash", label: __("Int"), width: 80, height: 20, font_size: 10 },
		{ type: "Float", icon: "hash", label: __("Float"), width: 90, height: 20, font_size: 10 },
		{ type: "Currency", icon: "money", label: __("Currency"), width: 100, height: 20, font_size: 10 },
		{ type: "Check", icon: "check", label: __("Check"), width: 14, height: 14, font_size: 10 },
		{ type: "Select", icon: "list", label: __("Select"), width: 120, height: 20, font_size: 10, options: "Option 1\nOption 2" },
		{ type: "Small Text", icon: "align-left", label: __("Small Text"), width: 200, height: 40, font_size: 10 },
		{ type: "Long Text", icon: "align-left", label: __("Long Text"), width: 200, height: 60, font_size: 10 },
	];

	const MIN_WIDTH_PT = 20;
	const MIN_HEIGHT_PT = 12;

	let pageInstance = null;
	let dragState = null;

	let state = {
		templateName: null,
		title: "",
		reference_doctype: "",
		pages: [],
		fields: [],
		reference_fields: [],
		source_types: ["Field Path", "Jinja Template", "Jinja Script"],
		date_formats: ["", "%d-%m-%Y", "%m/%d/%Y", "%Y-%m-%d", "%d/%m/%Y"],
		currentPage: 0,
		selectedId: null,
		dirty: false,
		scale: 1,
		fieldCounter: 1,
		fieldFilter: "",
		collapsedSections: {
			fieldTypes: false,
			referenceFields: false,
		},
	};

	function getTemplateName() {
		const route = frappe.get_route();
		if (route[0] !== "pdf-field-designer") return null;

		let name = null;
		if (route[1] && typeof route[1] === "string") {
			name = route[1];
		} else if (route[1] && typeof route[1] === "object" && route[1].name) {
			name = route[1].name;
		} else if (frappe.route_options && frappe.route_options.template) {
			name = frappe.route_options.template;
		}

		if (!name) return null;
		try {
			return decodeURIComponent(name);
		} catch (e) {
			return name;
		}
	}

	function getAppEl() {
		return document.getElementById("pdffiller-designer-app");
	}

	function getSelectedField() {
		return state.fields.find((field) => field.id === state.selectedId) || null;
	}

	function getCurrentPage() {
		return state.pages[state.currentPage] || null;
	}

	function getPageFields(pageNo) {
		return state.fields.filter((field) => field.page === pageNo);
	}

	function getScale() {
		const page = getCurrentPage();
		const wrap = document.querySelector(".pfd-canvas-wrap");
		if (!page || !wrap) return 1;
		return wrap.clientWidth / page.width_pt;
	}

	function ptToPx(pt) {
		return pt * state.scale;
	}

	function pxToPt(px) {
		return px / state.scale;
	}

	function nextFieldId() {
		state.fieldCounter += 1;
		return `fld_${Date.now()}_${state.fieldCounter}`;
	}

	function fieldNamePrefix(type) {
		const map = {
			Check: "check",
			Select: "select",
			Date: "date",
			Link: "link",
			Int: "int",
			Float: "float",
			Currency: "amount",
			"Small Text": "text",
			"Long Text": "notes",
		};
		return map[type] || "field";
	}

	function nextFieldName(type) {
		const prefix = fieldNamePrefix(type);
		let index = state.fieldCounter;
		let name = `${prefix}_${index}`;
		const existing = new Set(state.fields.map((field) => field.field_name));
		while (existing.has(name)) {
			index += 1;
			name = `${prefix}_${index}`;
		}
		state.fieldCounter = index + 1;
		return name;
	}

	function defaultMappingForType(type, spec) {
		return {
			source_type: "Field Path",
			source_field: "",
			jinja_script: "",
			default_value: "",
			date_format: spec?.date_format || (type === "Date" ? "%d-%m-%Y" : ""),
			editable: 0,
			options: spec?.options || "",
		};
	}

	function normalizeLoadedField(field) {
		const aliases = { Text: "Data", Checkbox: "Check" };
		const field_type = aliases[field.field_type] || field.field_type || "Data";
		return {
			source_type: field.source_type || "Field Path",
			source_field: field.source_field || "",
			jinja_script: field.jinja_script || "",
			default_value: field.default_value || "",
			date_format: field.date_format || "",
			editable: field.editable ? 1 : 0,
			options: field.options || "",
			...field,
			field_type,
			id: field.id || nextFieldId(),
		};
	}

	function markDirty() {
		state.dirty = true;
	}

	function loadContext(templateName) {
		return frappe.call({
			method: "pdffiller.api.designer.get_design_context",
			args: { template: templateName },
			freeze: true,
			freeze_message: __("Loading designer…"),
			callback(r) {
				const data = r.message;
				if (!data) {
					showMessage(__("Could not load the PDF template."));
					return;
				}
				state.templateName = data.template;
				state.title = data.title;
				state.reference_doctype = data.reference_doctype;
				state.pages = data.pages || [];
				state.reference_fields = data.reference_fields || [];
				state.source_types = data.source_types || state.source_types;
				state.date_formats = data.date_formats || state.date_formats;
				state.fields = (data.fields || []).map(normalizeLoadedField);
				state.currentPage = 0;
				state.selectedId = null;
				state.dirty = false;
				if (pageInstance) {
					pageInstance.set_title(state.title || __("PDF Field Designer"));
				}
				render();
			},
			error() {
				showMessage(__("Failed to load the PDF designer."));
			},
		});
	}

	function showMessage(message) {
		const app = getAppEl();
		if (!app) return;
		app.innerHTML = `<div class="pfd-loading">${frappe.utils.escape_html(message)}</div>`;
	}

	function saveDesign() {
		if (!state.templateName) return;

		const invalid = state.fields.find((field) => !field.field_name || !field.field_name.trim());
		if (invalid) {
			frappe.msgprint({
				title: __("Invalid Field"),
				message: __("Every field must have a name."),
				indicator: "orange",
			});
			return;
		}

		const names = state.fields.map((field) => field.field_name.trim());
		if (new Set(names).size !== names.length) {
			frappe.msgprint({
				title: __("Duplicate Names"),
				message: __("Field names must be unique."),
				indicator: "orange",
			});
			return;
		}

		const payload = state.fields.map((field) => ({
			field_name: field.field_name.trim(),
			field_type: field.field_type,
			page: field.page,
			x: round(field.x),
			y: round(field.y),
			width: round(field.width),
			height: round(field.height),
			font_size: field.font_size || 10,
			source_type: field.source_type || "Field Path",
			source_field: field.source_field || "",
			jinja_script: field.jinja_script || "",
			default_value: field.default_value || "",
			date_format: field.date_format || "",
			editable: field.editable ? 1 : 0,
			options: field.options || "",
		}));

		frappe.call({
			method: "pdffiller.api.designer.save_design",
			args: {
				template: state.templateName,
				fields: JSON.stringify(payload),
			},
			freeze: true,
			freeze_message: __("Saving design…"),
			callback(r) {
				const result = r.message || {};
				state.dirty = false;
				frappe.show_alert({
					message: __("Design saved ({0} field(s))", [result.field_names?.length || 0]),
					indicator: "green",
				});
				if (state.reference_doctype && pdffiller.forms && pdffiller.forms.clear_cache) {
					pdffiller.forms.clear_cache(state.reference_doctype);
				}
			},
		});
	}

	function round(value) {
		return Math.round(value * 100) / 100;
	}

	function deleteSelectedField() {
		if (!state.selectedId) return;
		state.fields = state.fields.filter((field) => field.id !== state.selectedId);
		state.selectedId = null;
		markDirty();
		render();
	}

	function addField(type, x, y, mappingOverrides = {}) {
		const spec = FIELD_TYPES.find((item) => item.type === type) || FIELD_TYPES[0];
		const page = getCurrentPage();
		if (!page) return;

		const width = spec.width;
		const height = spec.height;
		const maxX = Math.max(0, page.width_pt - width);
		const maxY = Math.max(0, page.height_pt - height);

		const field = {
			id: nextFieldId(),
			field_name: nextFieldName(type),
			field_type: type,
			page: state.currentPage,
			x: clamp(x, 0, maxX),
			y: clamp(y, 0, maxY),
			width,
			height,
			font_size: spec.font_size,
			...defaultMappingForType(type, spec),
			...mappingOverrides,
		};

		state.fields.push(field);
		state.selectedId = field.id;
		markDirty();
		render();
	}

	function mapReferenceField(refField) {
		const selected = getSelectedField();
		if (selected) {
			updateSelectedField(
				{
					source_type: "Field Path",
					source_field: refField.fieldname,
					field_type: mapFrappeFieldtype(refField.fieldtype, selected.field_type),
				},
				{ refreshCanvas: true }
			);
			return;
		}
		addField(mapFrappeFieldtype(refField.fieldtype, "Data"), 72, 72, {
			source_type: "Field Path",
			source_field: refField.fieldname,
			field_name: refField.fieldname.replace(/[^A-Za-z0-9_]/g, "_"),
		});
	}

	function mapFrappeFieldtype(fieldtype, fallback) {
		const supported = new Set(FIELD_TYPES.map((item) => item.type));
		if (supported.has(fieldtype)) return fieldtype;
		const map = {
			Data: "Data",
			Link: "Link",
			"Dynamic Link": "Link",
			Date: "Date",
			Datetime: "Date",
			Int: "Int",
			Float: "Float",
			Currency: "Currency",
			Check: "Check",
			Select: "Select",
			"Small Text": "Small Text",
			Text: "Long Text",
			"Text Editor": "Long Text",
			"Long Text": "Long Text",
		};
		return map[fieldtype] || fallback || "Data";
	}

	function clamp(value, min, max) {
		return Math.min(Math.max(value, min), max);
	}

	function updateSelectedField(updates, options = {}) {
		const field = getSelectedField();
		if (!field) return;
		Object.assign(field, updates);
		markDirty();
		if (options.refreshCanvas) {
			renderCanvasContainer();
		}
		if (options.refreshProperties) {
			renderPropertiesPanel();
		}
	}

	function filteredReferenceFields() {
		const q = (state.fieldFilter || "").trim().toLowerCase();
		if (!q) return state.reference_fields;
		return state.reference_fields.filter(
			(field) =>
				field.fieldname.toLowerCase().includes(q) ||
				(field.label || "").toLowerCase().includes(q) ||
				field.fieldtype.toLowerCase().includes(q)
		);
	}

	function renderCollapsibleSection(sectionId, title, bodyHtml) {
		const collapsed = state.collapsedSections[sectionId];
		return `
			<div class="pfd-collapsible-section${
				collapsed ? " pfd-collapsible-section--collapsed" : ""
			}" data-section="${sectionId}">
				<button type="button" class="pfd-panel-toggle" aria-expanded="${!collapsed}">
					<span class="pfd-panel-title">${title}</span>
					${frappe.utils.icon("down", "xs", "pfd-panel-toggle-icon")}
				</button>
				<div class="pfd-collapsible-body">
					${bodyHtml}
				</div>
			</div>
		`;
	}

	function renderPalette() {
		return FIELD_TYPES.map(
			(item) => `
			<div class="pfd-palette-item" draggable="true" data-type="${item.type}" title="${__(
				"Drag onto the PDF"
			)}">
				${frappe.utils.icon(item.icon, "sm")}
				<span>${item.label}</span>
			</div>
		`
		).join("");
	}

	function renderReferenceFields() {
		const fields = filteredReferenceFields();
		if (!state.reference_doctype) {
			return `<div class="pfd-help-text">${__("No reference DocType configured.")}</div>`;
		}
		if (!fields.length) {
			return `<div class="pfd-help-text">${__("No matching fields.")}</div>`;
		}
		return fields
			.map(
				(field) => `
			<div
				class="pfd-ref-field"
				draggable="true"
				data-fieldname="${frappe.utils.escape_html(field.fieldname)}"
				data-fieldtype="${frappe.utils.escape_html(field.fieldtype)}"
				title="${__("Click or drag to map")}
			">
				<span class="pfd-ref-name">${frappe.utils.escape_html(field.label || field.fieldname)}</span>
				<span class="pfd-ref-meta">${frappe.utils.escape_html(field.fieldname)} · ${frappe.utils.escape_html(
					field.fieldtype
				)}</span>
			</div>
		`
			)
			.join("");
	}

	function renderFieldOverlay(field) {
		const selected = field.id === state.selectedId ? " pfd-selected" : "";
		const left = ptToPx(field.x);
		const top = ptToPx(field.y);
		const width = ptToPx(field.width);
		const height = ptToPx(field.height);
		const label = frappe.utils.escape_html(field.field_name);
		const typeLabel = frappe.utils.escape_html(field.field_type);
		const mapLabel = field.source_field
			? frappe.utils.escape_html(field.source_field)
			: __("Unmapped");

		return `
			<div
				class="pfd-field-overlay${selected}"
				data-field-id="${field.id}"
				style="left:${left}px;top:${top}px;width:${width}px;height:${height}px;"
			>
				<span class="pfd-field-label">${label}</span>
				<span class="pfd-field-meta">${typeLabel} · ${mapLabel}</span>
				<div class="pfd-resize-handle" data-resize="1"></div>
			</div>
		`;
	}

	function renderCanvas() {
		const page = getCurrentPage();
		if (!page) {
			return `<div class="pfd-loading">${__("No PDF pages found")}</div>`;
		}

		state.scale = getScale();
		const fieldsHtml = getPageFields(state.currentPage).map(renderFieldOverlay).join("");

		return `
			<div class="pfd-page-nav">
				<button type="button" class="btn btn-default btn-sm pfd-prev-page" ${
					state.currentPage <= 0 ? "disabled" : ""
				}>${__("Previous")}</button>
				<span>${__("Page {0} of {1}", [state.currentPage + 1, state.pages.length])}</span>
				<button type="button" class="btn btn-default btn-sm pfd-next-page" ${
					state.currentPage >= state.pages.length - 1 ? "disabled" : ""
				}>${__("Next")}</button>
			</div>
			<div class="pfd-canvas-wrap" style="width:100%;max-width:${page.width_pt * 1.2}px;">
				<img class="pfd-canvas-image" src="${page.image_data_uri}" alt="${__(
					"PDF page"
				)} ${state.currentPage + 1}" draggable="false" />
				<div class="pfd-canvas-overlay">${fieldsHtml}</div>
			</div>
		`;
	}

	function renderSelectOptions(options, selected) {
		return options
			.map(
				(value) =>
					`<option value="${frappe.utils.escape_html(value)}" ${
						value === selected ? "selected" : ""
					}>${frappe.utils.escape_html(value || __("Default"))}</option>`
			)
			.join("");
	}

	function renderProperties() {
		const field = getSelectedField();
		if (!field) {
			return `<div class="pfd-empty-props">${__("Select a field to edit layout and mapping")}</div>`;
		}

		const showFont = !["Check", "Select"].includes(field.field_type);
		const showDateFormat = field.field_type === "Date" || field.date_format;
		const showOptions = field.field_type === "Select";
		const showSourceField = field.source_type !== "Jinja Script";
		const showJinjaScript = field.source_type === "Jinja Script";

		return `
			<div class="pfd-prop-section">
				<div class="pfd-panel-title">${__("Layout")}</div>
				<div class="pfd-form-group">
					<label>${__("Field Name")}</label>
					<input type="text" class="pfd-prop-name" value="${frappe.utils.escape_html(field.field_name)}" />
				</div>
				<div class="pfd-form-group">
					<label>${__("Field Type")}</label>
					<select class="pfd-prop-type">
						${renderSelectOptions(
							FIELD_TYPES.map((item) => item.type),
							field.field_type
						)}
					</select>
				</div>
				${
					showFont
						? `<div class="pfd-form-group">
							<label>${__("Font Size")}</label>
							<input type="number" class="pfd-prop-font" min="6" max="72" value="${field.font_size || 10}" />
						</div>`
						: ""
				}
				<div class="pfd-form-row">
					<div class="pfd-form-group">
						<label>${__("Width (pt)")}</label>
						<input type="number" class="pfd-prop-width" min="${MIN_WIDTH_PT}" value="${round(field.width)}" />
					</div>
					<div class="pfd-form-group">
						<label>${__("Height (pt)")}</label>
						<input type="number" class="pfd-prop-height" min="${MIN_HEIGHT_PT}" value="${round(field.height)}" />
					</div>
				</div>
				<div class="pfd-form-row">
					<div class="pfd-form-group">
						<label>${__("X (pt)")}</label>
						<input type="number" class="pfd-prop-x" min="0" value="${round(field.x)}" />
					</div>
					<div class="pfd-form-group">
						<label>${__("Y (pt)")}</label>
						<input type="number" class="pfd-prop-y" min="0" value="${round(field.y)}" />
					</div>
				</div>
			</div>

			<div class="pfd-prop-section">
				<div class="pfd-panel-title">${__("Mapping")}</div>
				<div class="pfd-form-group">
					<label>${__("Source Type")}</label>
					<select class="pfd-prop-source-type">
						${renderSelectOptions(state.source_types, field.source_type || "Field Path")}
					</select>
				</div>
				${
					showSourceField
						? `<div class="pfd-form-group">
							<label>${__("Source Field")}</label>
							<textarea class="pfd-prop-source-field" rows="2">${frappe.utils.escape_html(
								field.source_field || ""
							)}</textarea>
						</div>`
						: ""
				}
				${
					showJinjaScript
						? `<div class="pfd-form-group">
							<label>${__("Jinja Script")}</label>
							<textarea class="pfd-prop-jinja-script" rows="4">${frappe.utils.escape_html(
								field.jinja_script || ""
							)}</textarea>
						</div>`
						: ""
				}
				<div class="pfd-form-group">
					<label>${__("Default Value")}</label>
					<input type="text" class="pfd-prop-default-value" value="${frappe.utils.escape_html(
						field.default_value || ""
					)}" />
				</div>
				${
					showDateFormat
						? `<div class="pfd-form-group">
							<label>${__("Date Format")}</label>
							<select class="pfd-prop-date-format">
								${renderSelectOptions(state.date_formats, field.date_format || "")}
							</select>
						</div>`
						: ""
				}
				${
					showOptions
						? `<div class="pfd-form-group">
							<label>${__("Select Options")}</label>
							<textarea class="pfd-prop-options" rows="3" placeholder="${__(
								"One option per line"
							)}">${frappe.utils.escape_html(field.options || "")}</textarea>
						</div>`
						: ""
				}
				<div class="pfd-form-group pfd-checkbox-group">
					<label>
						<input type="checkbox" class="pfd-prop-editable" ${field.editable ? "checked" : ""} />
						${__("Editable in preview")}
					</label>
				</div>
			</div>

			<button type="button" class="btn btn-danger btn-sm pfd-delete-field">${__("Delete Field")}</button>
		`;
	}

	function render() {
		const app = getAppEl();
		if (!app) return;

		app.innerHTML = `
			<div class="pfd-toolbar">
				<div class="pfd-toolbar-title">${frappe.utils.escape_html(state.title || __("PDF Field Designer"))}</div>
				<div class="pfd-toolbar-subtitle">${frappe.utils.escape_html(state.reference_doctype || "")}</div>
				<div class="pfd-toolbar-actions">
					<button type="button" class="btn btn-default btn-sm pfd-cancel-btn">${__("Back")}</button>
					<button type="button" class="btn btn-primary btn-sm pfd-save-btn">${__("Save Design")}</button>
				</div>
			</div>
			<div class="pfd-main">
				<div class="pfd-left">
					${renderCollapsibleSection("fieldTypes", __("Field Types"), renderPalette())}
					${renderCollapsibleSection(
						"referenceFields",
						__("Reference Fields"),
						`<input type="text" class="pfd-field-filter" placeholder="${__("Search fields…")}" value="${frappe.utils.escape_html(
							state.fieldFilter
						)}" />
						<div class="pfd-ref-fields">${renderReferenceFields()}</div>`
					)}
				</div>
				<div class="pfd-center pfd-canvas-container">${renderCanvas()}</div>
				<div class="pfd-right">
					<div class="pfd-panel-title">${__("Properties")}</div>
					<div class="pfd-properties">${renderProperties()}</div>
				</div>
			</div>
		`;

		bindEvents(app);
	}

	function renderCanvasContainer() {
		const container = document.querySelector(".pfd-canvas-container");
		if (!container) return;
		container.innerHTML = renderCanvas();
		bindCanvasEvents(container);
	}

	function renderReferenceFieldsPanel() {
		const panel = document.querySelector(".pfd-ref-fields");
		if (!panel) return;
		panel.innerHTML = renderReferenceFields();
		bindReferenceFieldEvents(panel);
	}

	function renderPropertiesPanel() {
		const panel = document.querySelector(".pfd-properties");
		if (!panel) return;
		panel.innerHTML = renderProperties();
		bindPropertyEvents(panel);
	}

	function bindReferenceFieldEvents(container) {
		container.querySelectorAll(".pfd-ref-field").forEach((item) => {
			item.addEventListener("click", () => {
				mapReferenceField({
					fieldname: item.dataset.fieldname,
					fieldtype: item.dataset.fieldtype,
				});
			});
			item.addEventListener("dragstart", (e) => {
				e.dataTransfer.setData(
					"text/pfd-ref-field",
					JSON.stringify({
						fieldname: item.dataset.fieldname,
						fieldtype: item.dataset.fieldtype,
					})
				);
				e.dataTransfer.effectAllowed = "copy";
			});
		});
	}

	function bindEvents(app) {
		app.querySelector(".pfd-save-btn")?.addEventListener("click", saveDesign);
		app.querySelector(".pfd-cancel-btn")?.addEventListener("click", () => {
			if (state.dirty && !confirm(__("Discard unsaved changes?"))) return;
			frappe.set_route("Form", "PDF Form Template", state.templateName);
		});

		app.querySelectorAll(".pfd-palette-item").forEach((item) => {
			item.addEventListener("dragstart", (e) => {
				e.dataTransfer.setData("text/pfd-field-type", item.dataset.type);
				e.dataTransfer.effectAllowed = "copy";
			});
		});

		app.querySelectorAll(".pfd-panel-toggle").forEach((btn) => {
			btn.addEventListener("click", () => {
				const section = btn.closest(".pfd-collapsible-section");
				if (!section) return;
				const sectionId = section.dataset.section;
				section.classList.toggle("pfd-collapsible-section--collapsed");
				state.collapsedSections[sectionId] = section.classList.contains(
					"pfd-collapsible-section--collapsed"
				);
				btn.setAttribute("aria-expanded", !state.collapsedSections[sectionId]);
			});
		});

		app.querySelector(".pfd-field-filter")?.addEventListener("input", (e) => {
			state.fieldFilter = e.target.value;
			renderReferenceFieldsPanel();
		});

		bindReferenceFieldEvents(app.querySelector(".pfd-ref-fields"));
		bindCanvasEvents(app.querySelector(".pfd-canvas-container"));
		bindPropertyEvents(app.querySelector(".pfd-properties"));
	}

	function bindCanvasEvents(container) {
		if (!container) return;

		container.querySelector(".pfd-prev-page")?.addEventListener("click", () => {
			if (state.currentPage > 0) {
				state.currentPage -= 1;
				state.selectedId = null;
				renderCanvasContainer();
				renderPropertiesPanel();
			}
		});

		container.querySelector(".pfd-next-page")?.addEventListener("click", () => {
			if (state.currentPage < state.pages.length - 1) {
				state.currentPage += 1;
				state.selectedId = null;
				renderCanvasContainer();
				renderPropertiesPanel();
			}
		});

		const overlay = container.querySelector(".pfd-canvas-overlay");
		if (!overlay) return;

		overlay.addEventListener("dragover", (e) => {
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
			overlay.classList.add("pfd-drop-over");
		});

		overlay.addEventListener("dragleave", () => {
			overlay.classList.remove("pfd-drop-over");
		});

		overlay.addEventListener("drop", (e) => {
			e.preventDefault();
			overlay.classList.remove("pfd-drop-over");
			const rect = overlay.getBoundingClientRect();
			const x = pxToPt(e.clientX - rect.left);
			const y = pxToPt(e.clientY - rect.top);

			const refPayload = e.dataTransfer.getData("text/pfd-ref-field");
			if (refPayload) {
				try {
					mapReferenceField(JSON.parse(refPayload));
				} catch (err) {
					// ignore invalid payload
				}
				return;
			}

			const type = e.dataTransfer.getData("text/pfd-field-type");
			if (type) addField(type, x, y);
		});

		overlay.addEventListener("mousedown", onOverlayMouseDown);
		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) {
				state.selectedId = null;
				renderPropertiesPanel();
				renderCanvasContainer();
			}
		});
	}

	function bindPropertyEvents(panel) {
		if (!panel) return;

		panel.querySelector(".pfd-prop-name")?.addEventListener("input", (e) => {
			updateSelectedField({ field_name: e.target.value }, { refreshCanvas: true });
		});

		panel.querySelector(".pfd-prop-type")?.addEventListener("change", (e) => {
			const spec = FIELD_TYPES.find((item) => item.type === e.target.value);
			const updates = { field_type: e.target.value };
			if (spec && e.target.value === "Date") updates.date_format = spec.date_format || "%d-%m-%Y";
			if (spec && e.target.value === "Select" && !getSelectedField()?.options) {
				updates.options = spec.options || "";
			}
			updateSelectedField(updates, { refreshCanvas: true, refreshProperties: true });
		});

		panel.querySelector(".pfd-prop-font")?.addEventListener("input", (e) => {
			updateSelectedField({ font_size: parseFloat(e.target.value) || 10 });
		});

		panel.querySelector(".pfd-prop-width")?.addEventListener("change", (e) => {
			updateSelectedField(
				{ width: Math.max(MIN_WIDTH_PT, parseFloat(e.target.value) || MIN_WIDTH_PT) },
				{ refreshCanvas: true }
			);
		});

		panel.querySelector(".pfd-prop-height")?.addEventListener("change", (e) => {
			updateSelectedField(
				{ height: Math.max(MIN_HEIGHT_PT, parseFloat(e.target.value) || MIN_HEIGHT_PT) },
				{ refreshCanvas: true }
			);
		});

		panel.querySelector(".pfd-prop-x")?.addEventListener("change", (e) => {
			updateSelectedField({ x: Math.max(0, parseFloat(e.target.value) || 0) }, { refreshCanvas: true });
		});

		panel.querySelector(".pfd-prop-y")?.addEventListener("change", (e) => {
			updateSelectedField({ y: Math.max(0, parseFloat(e.target.value) || 0) }, { refreshCanvas: true });
		});

		panel.querySelector(".pfd-prop-source-type")?.addEventListener("change", (e) => {
			updateSelectedField({ source_type: e.target.value }, { refreshProperties: true });
		});

		panel.querySelector(".pfd-prop-source-field")?.addEventListener("input", (e) => {
			updateSelectedField({ source_field: e.target.value }, { refreshCanvas: true });
		});

		panel.querySelector(".pfd-prop-jinja-script")?.addEventListener("input", (e) => {
			updateSelectedField({ jinja_script: e.target.value });
		});

		panel.querySelector(".pfd-prop-default-value")?.addEventListener("input", (e) => {
			updateSelectedField({ default_value: e.target.value });
		});

		panel.querySelector(".pfd-prop-date-format")?.addEventListener("change", (e) => {
			updateSelectedField({ date_format: e.target.value });
		});

		panel.querySelector(".pfd-prop-options")?.addEventListener("input", (e) => {
			updateSelectedField({ options: e.target.value });
		});

		panel.querySelector(".pfd-prop-editable")?.addEventListener("change", (e) => {
			updateSelectedField({ editable: e.target.checked ? 1 : 0 });
		});

		panel.querySelector(".pfd-delete-field")?.addEventListener("click", deleteSelectedField);
	}

	function onOverlayMouseDown(e) {
		const fieldEl = e.target.closest(".pfd-field-overlay");
		if (!fieldEl) return;

		e.preventDefault();
		e.stopPropagation();

		const field = state.fields.find((item) => item.id === fieldEl.dataset.fieldId);
		if (!field) return;

		state.selectedId = field.id;
		renderPropertiesPanel();
		renderCanvasContainer();

		const isResize = e.target.dataset.resize === "1";
		const startX = e.clientX;
		const startY = e.clientY;
		const startField = { ...field };

		dragState = { field, isResize, startX, startY, startField };

		document.addEventListener("mousemove", onDocumentMouseMove);
		document.addEventListener("mouseup", onDocumentMouseUp);

		function onDocumentMouseMove(moveEvent) {
			if (!dragState) return;
			const dx = pxToPt(moveEvent.clientX - dragState.startX);
			const dy = pxToPt(moveEvent.clientY - dragState.startY);
			const page = getCurrentPage();
			if (!page) return;

			if (dragState.isResize) {
				const width = Math.max(MIN_WIDTH_PT, dragState.startField.width + dx);
				const height = Math.max(MIN_HEIGHT_PT, dragState.startField.height + dy);
				const maxWidth = page.width_pt - dragState.startField.x;
				const maxHeight = page.height_pt - dragState.startField.y;
				dragState.field.width = Math.min(width, maxWidth);
				dragState.field.height = Math.min(height, maxHeight);
			} else {
				const maxX = page.width_pt - dragState.startField.width;
				const maxY = page.height_pt - dragState.startField.height;
				dragState.field.x = clamp(dragState.startField.x + dx, 0, maxX);
				dragState.field.y = clamp(dragState.startField.y + dy, 0, maxY);
			}

			markDirty();
			renderCanvasContainer();
		}

		function onDocumentMouseUp() {
			document.removeEventListener("mousemove", onDocumentMouseMove);
			document.removeEventListener("mouseup", onDocumentMouseUp);
			dragState = null;
		}
	}

	function onKeyDown(e) {
		if (!state.selectedId) return;
		const tag = (e.target && e.target.tagName) || "";
		if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
		if (e.key === "Delete" || e.key === "Backspace") {
			e.preventDefault();
			deleteSelectedField();
		}
	}

	function refresh() {
		const app = getAppEl();
		if (!app) return;

		const templateName = getTemplateName();
		if (!templateName) {
			showMessage(__("Open a PDF Form Template and click Design Fields."));
			return;
		}

		if (state.templateName === templateName && state.pages.length) {
			state.scale = getScale();
			render();
			return;
		}

		showMessage(__("Loading designer…"));
		loadContext(templateName);
	}

	pdffiller.designer.setup_page = function (wrapper) {
		pageInstance = frappe.ui.make_app_page({
			parent: wrapper,
			title: __("PDF Field Designer"),
			single_column: true,
		});

		pageInstance.main
			.addClass("pdffiller-designer-page")
			.html('<div id="pdffiller-designer-app" class="pdffiller-designer-root"></div>');

		refresh();
	};

	pdffiller.designer.refresh = refresh;

	document.addEventListener("keydown", onKeyDown);

	window.addEventListener("beforeunload", (e) => {
		if (state.dirty) e.preventDefault();
	});
})();
