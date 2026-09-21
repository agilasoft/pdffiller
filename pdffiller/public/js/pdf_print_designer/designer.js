/* Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors */

frappe.provide("pdffiller.print_designer");

(function () {
	"use strict";

	const FIELD_TYPES = [
		{ type: "Data", icon: "text", label: __("Data Field"), width: 150, height: 20, font_size: 10 },
		{ type: "Link", icon: "link", label: __("Link Field"), width: 150, height: 20, font_size: 10 },
		{ type: "Date", icon: "calendar", label: __("Date Field"), width: 100, height: 20, font_size: 10, date_format: "%d-%m-%Y" },
		{ type: "Currency", icon: "money", label: __("Currency Field"), width: 100, height: 20, font_size: 10 },
		{ type: "Int", icon: "hash", label: __("Number Field"), width: 80, height: 20, font_size: 10 },
		{ type: "Check", icon: "check", label: __("Check Box"), width: 14, height: 14, font_size: 10 },
		{ type: "Select", icon: "list", label: __("Select Field"), width: 120, height: 20, font_size: 10, options: "Option 1\nOption 2" },
		{ type: "Small Text", icon: "align-left", label: __("Small Text"), width: 200, height: 40, font_size: 10 },
		{ type: "Long Text", icon: "align-left", label: __("Long Text"), width: 200, height: 60, font_size: 10 },
		{ type: "Barcode", icon: "barcode", label: __("Barcode"), width: 180, height: 48, font_size: 10 },
		{ type: "Image", icon: "image", label: __("Image Field"), width: 120, height: 120, font_size: 10 },
	];

	const DRAW_TOOLS = [
		{ kind: "text", icon: "text", label: __("Text"), width: 160, height: 22 },
		{ kind: "rect", icon: "checkbox", label: __("Rectangle"), width: 200, height: 80 },
		{ kind: "line", icon: "minus", label: __("Line"), width: 200, height: 0 },
		{ kind: "image", icon: "image", label: __("Image"), width: 120, height: 80 },
	];

	const MIN_WIDTH_PT = 8;
	const MIN_HEIGHT_PT = 8;
	const PAGE_ROLES = ["Once", "First", "Loop", "Last"];
	const ROW_GAP_PT = 4;
	const PAPER_ORDER = ["A4", "Letter", "Legal", "Custom"];
	const PT_PER_MM = 72 / 25.4;
	const LINE_HIT_PX = 12;
	const ZOOM_PRESETS = [0.1, 0.5, 1];
	const PAPER_LABELS = {
		A4: "A4 (210 × 297 mm)",
		Letter: "Letter (216 × 279 mm)",
		Legal: "Legal (216 × 356 mm)",
		Custom: __("Custom"),
	};

	let pageInstance = null;
	let dragState = null;
	let justDropped = false;

	let state = {
		designName: null,
		title: "",
		reference_doctype: "",
		paper_size: "A4",
		paper_sizes: {
			A4: { width: 595, height: 842 },
			Letter: { width: 612, height: 792 },
			Legal: { width: 612, height: 1008 },
		},
		layout: { page_width: 595, page_height: 842, pages: [{ role: "Once", elements: [] }] },
		reference_fields: [],
		source_types: ["Field Path", "Jinja Template", "Jinja Script"],
		date_formats: ["", "%d-%m-%Y", "%m/%d/%Y", "%Y-%m-%d", "%d/%m/%Y"],
		currentPage: 0,
		selectedId: null,
		dirty: false,
		scale: 1,
		elementCounter: 1,
		fieldFilter: "",
		leftTab: "elements",
		activeTool: "",
		zoom: 0.5,
		always_print_last: 0,
		child_tables: [],
	};

	function getDesignName() {
		const route = frappe.get_route();
		if (route[0] !== "pdf-print-designer") return null;

		let name = null;
		if (route[1] && typeof route[1] === "string") {
			name = route[1];
		} else if (route[1] && typeof route[1] === "object" && route[1].name) {
			name = route[1].name;
		} else if (frappe.route_options && frappe.route_options.design) {
			name = frappe.route_options.design;
		}

		if (!name) return null;
		try {
			return decodeURIComponent(name);
		} catch (e) {
			return name;
		}
	}

	function getAppEl() {
		return document.getElementById("pdffiller-print-designer-app");
	}

	function getCurrentPage() {
		return (state.layout.pages || [])[state.currentPage] || null;
	}

	function getPageElements() {
		const page = getCurrentPage();
		return page ? page.elements || [] : [];
	}

	function getSelectedElement() {
		return getPageElements().find((el) => el.id === state.selectedId) || null;
	}

	function pxPerPt() {
		return (96 / 72) * (state.zoom || 1);
	}

	function ptToPx(pt) {
		return Number(pt || 0) * pxPerPt();
	}

	function pxToPt(px) {
		return Number(px || 0) / pxPerPt();
	}

	function ptToMm(pt) {
		return round(Number(pt || 0) / PT_PER_MM);
	}

	function mmToPt(mm) {
		return Number(mm || 0) * PT_PER_MM;
	}

	function getScale() {
		return pxPerPt();
	}

	function round(value) {
		return Math.round(value * 100) / 100;
	}

	function clamp(value, min, max) {
		return Math.min(Math.max(value, min), max);
	}

	function nextElementId() {
		state.elementCounter += 1;
		return `el_${Date.now()}_${state.elementCounter}`;
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
			Barcode: "barcode",
			Image: "image",
		};
		return map[type] || "field";
	}

	function allFieldNames() {
		const names = [];
		(state.layout.pages || []).forEach((page) => {
			(page.elements || []).forEach((el) => {
				if (el.kind === "field" && el.field_name) names.push(el.field_name);
			});
		});
		return names;
	}

	function nextFieldName(type) {
		const prefix = fieldNamePrefix(type);
		let index = state.elementCounter;
		let name = `${prefix}_${index}`;
		const existing = new Set(allFieldNames());
		while (existing.has(name)) {
			index += 1;
			name = `${prefix}_${index}`;
		}
		state.elementCounter = index + 1;
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
			repeat_table: "",
			repeat_field: "",
			repeat_slot: 0,
		};
	}

	function markDirty() {
		state.dirty = true;
	}

	function normalizeLoadedElement(element) {
		const aliases = { Text: "Data", Checkbox: "Check" };
		const kind = element.kind || "field";
		const base = {
			id: element.id || nextElementId(),
			kind,
			x: Number(element.x || 0),
			y: Number(element.y || 0),
			width: Number(element.width || 0),
			height: Number(element.height || 0),
			font_size: Number(element.font_size || 10),
			color: element.color || "#000000",
			stroke: element.stroke || "#000000",
			fill: element.fill || "",
			line_width: Number(element.line_width || 1),
			text: element.text || (kind === "text" ? __("Label") : ""),
			align: element.align || "left",
			image_url: element.image_url || "",
			line_style: element.line_style || "solid",
		};
		if (kind !== "field") return { ...element, ...base, kind };
		const field_type = aliases[element.field_type] || element.field_type || "Data";
		return {
			...defaultMappingForType(field_type),
			...element,
			...base,
			kind: "field",
			field_type,
			field_name: element.field_name || nextFieldName(field_type),
			repeat_slot: Number(element.repeat_slot || 0),
			editable: element.editable ? 1 : 0,
		};
	}

	function loadContext(designName) {
		return frappe.call({
			method: "pdffiller.api.print_designer.get_design_context",
			args: { design: designName },
			freeze: true,
			freeze_message: __("Loading designer…"),
			callback(r) {
				const data = r.message;
				if (!data) {
					showMessage(__("Could not load the print design."));
					return;
				}
				state.designName = data.design;
				state.title = data.title;
				state.reference_doctype = data.reference_doctype;
				state.paper_size = data.paper_size || "A4";
				state.paper_sizes = data.paper_sizes || state.paper_sizes;
				state.reference_fields = data.reference_fields || [];
				state.source_types = data.source_types || state.source_types;
				state.date_formats = data.date_formats || state.date_formats;
				state.child_tables = data.child_tables || [];
				state.always_print_last = data.always_print_last ? 1 : 0;
				const layout = data.layout || {
					page_width: data.page_width || 595,
					page_height: data.page_height || 842,
					pages: [{ role: "Once", elements: [] }],
				};
				layout.pages = (layout.pages || []).map((page) => ({
					role: page.role || "Once",
					elements: (page.elements || []).map(normalizeLoadedElement),
				}));
				if (!layout.pages.length) {
					layout.pages = [{ role: "Once", elements: [] }];
				}
				state.layout = layout;
				state.currentPage = 0;
				state.selectedId = null;
				state.dirty = false;
				if (pageInstance) {
					pageInstance.set_title(state.title || __("PDF Print Designer"));
				}
				render();
			},
			error() {
				showMessage(__("Failed to load the print designer."));
			},
		});
	}

	function showMessage(message) {
		const app = getAppEl();
		if (!app) return;
		app.innerHTML = `<div class="pfd-loading">${frappe.utils.escape_html(message)}</div>`;
	}

	function getLayoutPayload() {
		return {
			page_width: round(state.layout.page_width),
			page_height: round(state.layout.page_height),
			pages: (state.layout.pages || []).map((page) => ({
				role: page.role || "Once",
				elements: (page.elements || []).map((el) => {
					const payload = {
						id: el.id,
						kind: el.kind,
						x: round(el.x),
						y: round(el.y),
						width: round(el.width),
						height: round(el.height),
						font_size: el.font_size || 10,
						color: el.color || "#000000",
						stroke: el.stroke || "#000000",
						fill: el.fill || "",
						line_width: Number(el.line_width || 1),
						text: el.text || "",
						align: el.align || "left",
						image_url: el.image_url || "",
						line_style: el.line_style || "solid",
					};
					if (el.kind === "field") {
						Object.assign(payload, {
							field_name: (el.field_name || "").trim(),
							field_type: el.field_type,
							source_type: el.source_type || "Field Path",
							source_field: el.source_field || "",
							jinja_script: el.jinja_script || "",
							default_value: el.default_value || "",
							date_format: el.date_format || "",
							editable: el.editable ? 1 : 0,
							options: el.options || "",
							repeat_table: el.repeat_table || "",
							repeat_field: el.repeat_field || "",
							repeat_slot: Number(el.repeat_slot || 0),
						});
					}
					return payload;
				}),
			})),
		};
	}

	function saveDesign() {
		if (!state.designName) return;

		const fields = [];
		(state.layout.pages || []).forEach((page) => {
			(page.elements || []).forEach((el) => {
				if (el.kind === "field") fields.push(el);
			});
		});
		const invalid = fields.find((field) => !field.field_name || !field.field_name.trim());
		if (invalid) {
			frappe.msgprint({
				title: __("Invalid Field"),
				message: __("Every bound field must have a name."),
				indicator: "orange",
			});
			return;
		}
		const names = fields.map((field) => field.field_name.trim());
		if (new Set(names).size !== names.length) {
			frappe.msgprint({
				title: __("Duplicate Names"),
				message: __("Field names must be unique."),
				indicator: "orange",
			});
			return;
		}

		frappe.call({
			method: "pdffiller.api.print_designer.save_design",
			args: {
				design: state.designName,
				layout: JSON.stringify(getLayoutPayload()),
				always_print_last: state.always_print_last ? 1 : 0,
				paper_size: state.paper_size,
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
				loadContext(state.designName);
			},
		});
	}

	function deleteSelected() {
		if (!state.selectedId) return;
		const page = getCurrentPage();
		if (!page) return;
		page.elements = (page.elements || []).filter((el) => el.id !== state.selectedId);
		state.selectedId = null;
		markDirty();
		render();
	}

	function addDrawElement(kind, x, y) {
		const spec = DRAW_TOOLS.find((item) => item.kind === kind) || DRAW_TOOLS[0];
		const width = spec.width;
		const height = kind === "line" ? 0 : spec.height;
		const maxX = Math.max(0, state.layout.page_width - width);
		const maxY = Math.max(0, state.layout.page_height - (height || 8));
		const element = {
			id: nextElementId(),
			kind,
			x: clamp(x, 0, maxX),
			y: clamp(y, 0, maxY),
			width,
			height,
			font_size: 12,
			color: "#000000",
			stroke: "#000000",
			fill: "",
			line_width: 1,
			text: kind === "text" ? __("Label") : "",
			align: "left",
			image_url: "",
			line_style: "solid",
		};
		const page = getCurrentPage();
		if (!page) return;
		page.elements = page.elements || [];
		page.elements.push(element);
		state.selectedId = element.id;
		state.activeTool = kind;
		markDirty();
		render();
	}

	function addField(type, x, y, mappingOverrides = {}) {
		const spec = FIELD_TYPES.find((item) => item.type === type) || FIELD_TYPES[0];
		const page = getCurrentPage();
		if (!page) return;
		const width = spec.width;
		const height = spec.height;
		const maxX = Math.max(0, state.layout.page_width - width);
		const maxY = Math.max(0, state.layout.page_height - height);
		const field = {
			id: nextElementId(),
			kind: "field",
			field_name: nextFieldName(type),
			field_type: type,
			x: clamp(x, 0, maxX),
			y: clamp(y, 0, maxY),
			width,
			height,
			font_size: spec.font_size,
			color: "#000000",
			...defaultMappingForType(type, spec),
			...mappingOverrides,
		};
		page.elements.push(field);
		state.selectedId = field.id;
		markDirty();
		render();
	}

	function mapReferenceField(refField) {
		const selected = getSelectedElement();
		if (selected && selected.kind === "field") {
			updateSelected(
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
			Barcode: "Barcode",
			Image: "Image",
			"Attach Image": "Image",
			Attach: "Image",
		};
		return map[fieldtype] || fallback || "Data";
	}

	function mapChildField(tableField, childField) {
		const selected = getSelectedElement();
		const updates = {
			source_type: "Field Path",
			source_field: childField.fieldname,
			repeat_table: tableField.fieldname,
			repeat_field: childField.fieldname,
			repeat_slot: selected && selected.kind === "field" ? Number(selected.repeat_slot || 0) : 0,
			field_type: mapFrappeFieldtype(childField.fieldtype, selected?.field_type || "Data"),
		};
		if (selected && selected.kind === "field") {
			updateSelected(updates, { refreshCanvas: true, refreshProperties: true });
			return;
		}
		addField(updates.field_type, 72, 72, {
			...updates,
			field_name: `${tableField.fieldname}_${childField.fieldname}`.replace(/[^A-Za-z0-9_]/g, "_"),
		});
	}

	function currentRepeatSlotCount(tableName) {
		const slots = getPageElements()
			.filter((el) => el.kind === "field" && el.repeat_table === tableName && el.repeat_table)
			.map((el) => Number(el.repeat_slot || 0));
		if (!slots.length) return 0;
		return Math.max(...slots) + 1;
	}

	function tileRepeatRows(rowsPerPage) {
		const selected = getSelectedElement();
		if (!selected || selected.kind !== "field" || !selected.repeat_table) {
			frappe.msgprint({
				title: __("Repeating row"),
				message: __("Select a field mapped to a child table first."),
				indicator: "orange",
			});
			return;
		}
		const page = getCurrentPage();
		if (!page) return;
		const table = selected.repeat_table;
		let prototypes = page.elements.filter(
			(el) =>
				el.kind === "field" &&
				el.repeat_table === table &&
				Number(el.repeat_slot || 0) === 0
		);
		if (!prototypes.length) {
			selected.repeat_slot = 0;
			prototypes = [selected];
		}
		const count = Math.max(1, parseInt(rowsPerPage, 10) || 1);
		const minY = Math.min(...prototypes.map((el) => el.y));
		const maxBottom = Math.max(...prototypes.map((el) => el.y + el.height));
		const rowHeight = maxBottom - minY + ROW_GAP_PT;
		const lastBottom = minY + rowHeight * count - ROW_GAP_PT;
		if (lastBottom > state.layout.page_height) {
			frappe.msgprint({
				title: __("Not enough space"),
				message: __("Those rows do not fit on this page. Use fewer rows or a Loop page."),
				indicator: "orange",
			});
			return;
		}
		page.elements = page.elements.filter(
			(el) =>
				!(
					el.kind === "field" &&
					el.repeat_table === table &&
					Number(el.repeat_slot || 0) >= count
				)
		);
		const existingSlots = new Set(
			page.elements
				.filter((el) => el.kind === "field" && el.repeat_table === table)
				.map((el) => Number(el.repeat_slot || 0))
		);
		for (let slot = 1; slot < count; slot += 1) {
			if (existingSlots.has(slot)) continue;
			prototypes.forEach((proto) => {
				page.elements.push({
					...proto,
					id: nextElementId(),
					field_name: nextFieldName(proto.field_type),
					y: proto.y + slot * rowHeight,
					repeat_slot: slot,
					repeat_table: table,
					repeat_field: proto.repeat_field || proto.source_field || "",
				});
			});
		}
		markDirty();
		render();
	}

	function previewWithDocument() {
		if (!state.reference_doctype || !state.designName) return;
		if (state.dirty) {
			frappe.msgprint({
				title: __("Save first"),
				message: __("Save the design before previewing a document."),
				indicator: "orange",
			});
			return;
		}
		const dialog = new frappe.ui.Dialog({
			title: __("Preview with document"),
			fields: [
				{
					fieldtype: "Link",
					options: state.reference_doctype,
					fieldname: "name",
					label: __("Document"),
					reqd: 1,
				},
			],
			primary_action_label: __("Preview"),
			primary_action(values) {
				dialog.hide();
				frappe.call({
					method: "pdffiller.api.forms.get_filled_pdf",
					args: {
						template: state.designName,
						doctype: state.reference_doctype,
						name: values.name,
						source: "print_design",
					},
					freeze: true,
					freeze_message: __("Building preview…"),
					callback(r) {
						const uri = r.message && r.message.data_uri;
						if (!uri) return;
						const win = window.open("", "_blank");
						if (!win) return;
						win.document.write(
							`<!DOCTYPE html><title>${frappe.utils.escape_html(
								__("PDF Preview")
							)}</title><iframe src="${uri}" style="position:fixed;inset:0;border:0;width:100%;height:100%"></iframe>`
						);
					},
				});
			},
		});
		dialog.show();
	}

	function updateSelected(updates, options = {}) {
		const el = getSelectedElement();
		if (!el) return;
		Object.assign(el, updates);
		markDirty();
		if (options.refreshCanvas) renderCanvasContainer();
		if (options.refreshProperties) renderPropertiesPanel();
	}

	function setPaperSize(name) {
		state.paper_size = name;
		const size = state.paper_sizes[name];
		if (size) {
			state.layout.page_width = size.width;
			state.layout.page_height = size.height;
		}
		markDirty();
		render();
	}

	function addPage() {
		state.layout.pages.push({ role: "Once", elements: [] });
		state.currentPage = state.layout.pages.length - 1;
		state.selectedId = null;
		markDirty();
		render();
	}

	function removePage() {
		if ((state.layout.pages || []).length <= 1) {
			frappe.msgprint({
				title: __("Last page"),
				message: __("A print design needs at least one page."),
				indicator: "orange",
			});
			return;
		}
		state.layout.pages.splice(state.currentPage, 1);
		state.currentPage = Math.min(state.currentPage, state.layout.pages.length - 1);
		state.selectedId = null;
		markDirty();
		render();
	}

	function duplicateSelected() {
		const el = getSelectedElement();
		const page = getCurrentPage();
		if (!el || !page) return;
		const clone = {
			...el,
			id: nextElementId(),
			x: Number(el.x || 0) + 8,
			y: Number(el.y || 0) + 8,
		};
		if (clone.kind === "field") {
			clone.field_name = nextFieldName(clone.field_type);
		}
		page.elements.push(clone);
		state.selectedId = clone.id;
		markDirty();
		render();
	}

	function moveSelectedZ(where) {
		const page = getCurrentPage();
		if (!page || !state.selectedId) return;
		const idx = page.elements.findIndex((el) => el.id === state.selectedId);
		if (idx < 0) return;
		const [el] = page.elements.splice(idx, 1);
		if (where === "front") page.elements.push(el);
		else if (where === "back") page.elements.unshift(el);
		else if (where === "forward") page.elements.splice(Math.min(idx + 1, page.elements.length), 0, el);
		else page.elements.splice(Math.max(idx - 1, 0), 0, el);
		markDirty();
		renderCanvasContainer();
	}

	function setZoom(zoom) {
		state.zoom = clamp(zoom, 0.1, 2);
		renderCanvasContainer();
	}

	function zoomToFit() {
		const scroll = document.querySelector(".ppd-canvas-scroll");
		if (!scroll) {
			state.zoom = 0.5;
			renderCanvasContainer();
			return;
		}
		const availW = Math.max(120, scroll.clientWidth - 48);
		const availH = Math.max(120, scroll.clientHeight - 48);
		const fitW = availW / (state.layout.page_width * (96 / 72));
		const fitH = availH / (state.layout.page_height * (96 / 72));
		state.zoom = clamp(Math.min(fitW, fitH, 1), 0.1, 1);
		renderCanvasContainer();
	}

	function addChildTableRow() {
		const table = (state.child_tables || [])[0];
		if (!table) {
			frappe.msgprint({
				title: __("No child table"),
				message: __("This DocType has no child tables to bind."),
				indicator: "orange",
			});
			return;
		}
		const col = (table.fields || [])[0] || { fieldname: "name", fieldtype: "Data" };
		mapChildField(table, col);
	}

	function filteredReferenceFields() {
		const q = (state.fieldFilter || "").trim().toLowerCase();
		if (!q) return state.reference_fields;
		return state.reference_fields.filter(
			(field) =>
				field.fieldname.toLowerCase().includes(q) ||
				(field.label || "").toLowerCase().includes(q) ||
				(field.fieldtype || "").toLowerCase().includes(q)
		);
	}

	function renderTool(item, datasetKey, datasetValue, active) {
		return `<button type="button" class="ppd-tool${active ? " is-active" : ""}" draggable="true" ${datasetKey}="${datasetValue}">
			<span class="ppd-tool-icon">${frappe.utils.icon(item.icon, "sm")}</span>
			<span>${item.label}</span>
		</button>`;
	}

	function renderDrawTools() {
		return DRAW_TOOLS.map((item) =>
			renderTool(item, "data-draw-kind", item.kind, state.activeTool === item.kind)
		).join("");
	}

	function renderFieldPalette() {
		const tools = FIELD_TYPES.map((item) => renderTool(item, "data-type", item.type, false)).join("");
		const child = `<button type="button" class="ppd-tool" data-child-row="1">
			<span class="ppd-tool-icon">${frappe.utils.icon("list", "sm")}</span>
			<span>${__("Child Table Row")}</span>
		</button>`;
		return tools + child;
	}

	function renderLeftPanel() {
		if (state.leftTab === "fields") {
			return `<input type="text" class="pfd-field-filter" placeholder="${__("Search fields…")}" value="${frappe.utils.escape_html(
				state.fieldFilter
			)}" />
			<div class="pfd-ref-fields">${renderReferenceFields()}</div>
			<div class="ppd-section-label">${__("Child Tables")}</div>
			${renderChildTables()}`;
		}
		return `<div class="ppd-section-label">${__("Draw Elements")}</div>
			${renderDrawTools()}
			<div class="ppd-section-label ppd-bind-list">${__("Form Fields (Bind)")}</div>
			${renderFieldPalette()}`;
	}

	function renderReferenceFields() {
		if (!state.reference_doctype) {
			return `<div class="pfd-help-text">${__("No reference DocType configured.")}</div>`;
		}
		const fields = filteredReferenceFields();
		if (!fields.length) {
			return `<div class="pfd-help-text">${__("No matching fields.")}</div>`;
		}
		return fields
			.map(
				(field) => `<div
				class="pfd-ref-field"
				draggable="true"
				data-fieldname="${frappe.utils.escape_html(field.fieldname)}"
				data-fieldtype="${frappe.utils.escape_html(field.fieldtype)}"
			>
				<span class="pfd-ref-name">${frappe.utils.escape_html(field.label || field.fieldname)}</span>
				<span class="pfd-ref-meta">${frappe.utils.escape_html(field.fieldname)} · ${frappe.utils.escape_html(
					field.fieldtype
				)}</span>
			</div>`
			)
			.join("");
	}

	function renderChildTables() {
		if (!(state.child_tables || []).length) {
			return `<div class="pfd-help-text">${__("No child tables on this DocType.")}</div>`;
		}
		return state.child_tables
			.map((table) => {
				const fields = (table.fields || [])
					.map(
						(field) => `<div
						class="pfd-ref-field pfd-child-field"
						data-table="${frappe.utils.escape_html(table.fieldname)}"
						data-fieldname="${frappe.utils.escape_html(field.fieldname)}"
						data-fieldtype="${frappe.utils.escape_html(field.fieldtype)}"
					>
						<span class="pfd-ref-name">${frappe.utils.escape_html(field.label || field.fieldname)}</span>
						<span class="pfd-ref-meta">${frappe.utils.escape_html(table.fieldname)}.${frappe.utils.escape_html(
							field.fieldname
						)}</span>
					</div>`
					)
					.join("");
				return `<div class="pfd-child-table">
					<div class="pfd-child-table-title">${frappe.utils.escape_html(table.label || table.fieldname)}</div>
					${fields || `<div class="pfd-help-text">${__("No columns")}</div>`}
				</div>`;
			})
			.join("");
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

	function boxStyle(el, extra = "") {
		return `left:${ptToPx(el.x)}px;top:${ptToPx(el.y)}px;width:${ptToPx(
			Math.max(el.width, 4)
		)}px;height:${ptToPx(Math.max(el.height, 4))}px;${extra}`;
	}

	function lineGeometry(el) {
		const dx = Number(el.width) || 0;
		const dy = Number(el.height) || 0;
		const absW = Math.max(Math.abs(dx), 1);
		const absH = Math.abs(dy);
		const horiz = absH < 0.25;
		const cssW = ptToPx(absW);
		const cssH = horiz ? LINE_HIT_PX * 2 : Math.max(ptToPx(absH), 1);
		const left = ptToPx(el.x + Math.min(0, dx));
		const top = ptToPx(el.y + Math.min(0, dy)) - (horiz ? LINE_HIT_PX : 0);
		let x1;
		let y1;
		let x2;
		let y2;
		if (horiz) {
			x1 = dx >= 0 ? 0 : cssW;
			x2 = dx >= 0 ? cssW : 0;
			y1 = LINE_HIT_PX;
			y2 = LINE_HIT_PX;
		} else {
			x1 = dx >= 0 ? 0 : cssW;
			y1 = dy >= 0 ? 0 : cssH;
			x2 = dx >= 0 ? cssW : 0;
			y2 = dy >= 0 ? cssH : 0;
		}
		return { left, top, cssW, cssH, x1, y1, x2, y2 };
	}

	function renderImagePreview(src) {
		if (src) {
			return `<img src="${frappe.utils.escape_html(src)}" alt="" draggable="false" />`;
		}
		return `<div class="pfd-image-placeholder">${frappe.utils.icon("image", "md")}</div>`;
	}

	function renderFieldOverlay(field) {
		const selected = field.id === state.selectedId ? " pfd-selected" : "";
		const repeatClass = field.repeat_table ? " pfd-field-overlay--repeat" : "";
		const mapLabel = field.repeat_table
			? `${field.repeat_table}[${Number(field.repeat_slot || 0)}].${
					field.repeat_field || field.source_field || ""
			  }`
			: field.source_field || field.field_name;
		const typeLabel = field.field_type || "Data";
		const specialClass =
			field.field_type === "Barcode"
				? " pfd-field-overlay--barcode"
				: field.field_type === "Image"
					? " pfd-field-overlay--image"
					: "";
		const barcode = field.field_type === "Barcode"
			? `<svg class="pfd-barcode-preview" data-barcode-value="${frappe.utils.escape_html(
					field.default_value || "1234567890"
			  )}"></svg>`
			: "";
		const image =
			field.field_type === "Image" ? renderImagePreview(field.default_value || "") : "";
		return `<div
			class="pfd-field-overlay${selected}${specialClass}${repeatClass}"
			data-element-id="${frappe.utils.escape_html(field.id)}"
			style="${boxStyle(field)}"
		>
			${barcode}${image}
			<span class="pfd-field-label">${frappe.utils.escape_html(field.field_name)}</span>
			<span class="pfd-field-meta">${frappe.utils.escape_html(typeLabel)} · ${frappe.utils.escape_html(
				mapLabel
			)}</span>
			<div class="pfd-resize-handle" data-resize="1"></div>
		</div>`;
	}

	function renderStaticElement(el) {
		const selected = el.id === state.selectedId ? " pfd-selected" : "";
		if (el.kind === "text") {
			return `<div class="ppd-element ppd-element--text${selected}" data-element-id="${frappe.utils.escape_html(
				el.id
			)}" style="${boxStyle(el, `font-size:${ptToPx(el.font_size || 10)}px;color:${el.color || "#000"};`)}">
				<span class="ppd-element-text">${frappe.utils.escape_html(el.text || "")}</span>
				<div class="pfd-resize-handle" data-resize="1"></div>
			</div>`;
		}
		if (el.kind === "rect") {
			const fill = el.fill || "transparent";
			return `<div class="ppd-element ppd-element--rect${selected}" data-element-id="${frappe.utils.escape_html(
				el.id
			)}" style="${boxStyle(
				el,
				`border-color:${el.stroke || "#000"};border-width:${Math.max(el.line_width || 1, 1)}px;background:${fill};`
			)}">
				<div class="pfd-resize-handle" data-resize="1"></div>
			</div>`;
		}
		if (el.kind === "line") {
			const g = lineGeometry(el);
			const selected = el.id === state.selectedId ? " pfd-selected" : "";
			const dash = el.line_style === "dashed" ? 'stroke-dasharray="6 4"' : "";
			const handles =
				el.id === state.selectedId
					? `<div class="ppd-line-handle" data-endpoint="start" style="left:${g.x1 - 4}px;top:${
							g.y1 - 4
					  }px"></div>
					<div class="ppd-line-handle" data-endpoint="end" style="left:${g.x2 - 4}px;top:${g.y2 - 4}px"></div>`
					: "";
			return `<div class="ppd-element ppd-element--line${selected}" data-element-id="${frappe.utils.escape_html(
				el.id
			)}" style="left:${g.left}px;top:${g.top}px;width:${g.cssW}px;height:${g.cssH}px;">
				<svg width="${g.cssW}" height="${g.cssH}" overflow="visible">
					<line x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}" stroke="${frappe.utils.escape_html(
						el.stroke || el.color || "#000000"
					)}" stroke-width="${el.line_width || 1}" stroke-linecap="butt" ${dash} />
				</svg>
				${handles}
			</div>`;
		}
		if (el.kind === "image") {
			return `<div class="ppd-element ppd-element--image${selected}" data-element-id="${frappe.utils.escape_html(
				el.id
			)}" style="${boxStyle(el)}">
				${renderImagePreview(el.image_url || "")}
				<div class="pfd-resize-handle" data-resize="1"></div>
			</div>`;
		}
		return "";
	}

	function renderRuler(axis, lengthPt, offsetPx) {
		const mmLen = lengthPt / PT_PER_MM;
		const ticks = [];
		for (let mm = 0; mm <= mmLen + 0.01; mm += 5) {
			const pos = offsetPx + ptToPx(mm * PT_PER_MM);
			const major = mm % 50 === 0;
			const size = major ? 10 : mm % 10 === 0 ? 7 : 4;
			if (axis === "x") {
				ticks.push(
					`<span class="ppd-ruler-tick" style="left:${pos}px;height:${size}px"></span>`
				);
				if (major) {
					ticks.push(
						`<span class="ppd-ruler-label" style="left:${pos + 3}px;top:2px">${mm}</span>`
					);
				}
			} else {
				ticks.push(
					`<span class="ppd-ruler-tick" style="top:${pos}px;width:${size}px"></span>`
				);
				if (major && mm > 0) {
					ticks.push(
						`<span class="ppd-ruler-label" style="top:${pos + 3}px;left:2px">${mm}</span>`
					);
				}
			}
		}
		return ticks.join("");
	}

	function renderFloatToolbar(el) {
		if (!el || el.id !== state.selectedId) return "";
		const left = el.kind === "line" ? lineGeometry(el).left + lineGeometry(el).cssW / 2 : ptToPx(el.x + el.width / 2);
		const top = el.kind === "line" ? lineGeometry(el).top : ptToPx(el.y);
		return `<div class="ppd-float-toolbar" style="left:${left}px;top:${top}px">
			<button type="button" class="ppd-dup-btn" title="${__("Duplicate")}">${frappe.utils.icon("copy", "xs")}</button>
			<button type="button" class="ppd-delete-float" title="${__("Delete")}">${frappe.utils.icon("delete", "xs")}</button>
		</div>`;
	}

	function renderCanvas() {
		const page = getCurrentPage();
		if (!page) {
			return `<div class="pfd-loading">${__("No pages found")}</div>`;
		}
		state.scale = getScale();
		const pageW = ptToPx(state.layout.page_width);
		const pageH = ptToPx(state.layout.page_height);
		const elementsHtml = (page.elements || [])
			.map((el) => (el.kind === "field" ? renderFieldOverlay(el) : renderStaticElement(el)))
			.join("");
		const selected = getSelectedElement();
		const roleOptions = PAGE_ROLES.map(
			(role) =>
				`<option value="${role}" ${role === (page.role || "Once") ? "selected" : ""}>${__(role)}</option>`
		).join("");
		const paperOptions = PAPER_ORDER.map(
			(name) =>
				`<option value="${name}" ${name === state.paper_size ? "selected" : ""}>${frappe.utils.escape_html(
					PAPER_LABELS[name] || name
				)}</option>`
		).join("");
		const pageOptions = state.layout.pages
			.map(
				(_p, idx) =>
					`<option value="${idx}" ${idx === state.currentPage ? "selected" : ""}>${__(
						"Page {0} of {1}",
						[idx + 1, state.layout.pages.length]
					)}</option>`
			)
			.join("");
		const zoomButtons = ZOOM_PRESETS.map((z) => {
			const label = `${Math.round(z * 100)}`;
			return `<button type="button" class="ppd-zoom-preset${
				Math.abs(state.zoom - z) < 0.01 ? " is-active" : ""
			}" data-zoom="${z}">${label}</button>`;
		}).join("");
		return `
			<div class="ppd-canvas-toolbar">
				<select class="ppd-page-select">${pageOptions}</select>
				<button type="button" class="btn btn-default btn-xs pfd-prev-page" ${
					state.currentPage <= 0 ? "disabled" : ""
				}>‹</button>
				<button type="button" class="btn btn-default btn-xs pfd-next-page" ${
					state.currentPage >= state.layout.pages.length - 1 ? "disabled" : ""
				}>›</button>
				<button type="button" class="btn btn-default btn-xs ppd-add-page">${frappe.utils.icon(
					"add",
					"xs"
				)} ${__("Add Page")}</button>
				<button type="button" class="btn btn-default btn-xs ppd-remove-page">${frappe.utils.icon(
					"delete",
					"xs"
				)} ${__("Remove Page")}</button>
				<label class="ppd-toolbar-field">${__("Role")}
					<select class="pfd-page-role">${roleOptions}</select>
				</label>
				<label class="ppd-toolbar-field">${__("Paper")}
					<select class="ppd-paper-select">${paperOptions}</select>
				</label>
				${
					state.paper_size === "Custom"
						? `<input type="number" class="ppd-custom-size ppd-custom-width" min="72" value="${round(
								state.layout.page_width
						  )}" title="${__("Width (pt)")}" />
						   <input type="number" class="ppd-custom-size ppd-custom-height" min="72" value="${round(
								state.layout.page_height
						  )}" title="${__("Height (pt)")}" />`
						: ""
				}
				<label class="ppd-toolbar-field pfd-always-last">
					<input type="checkbox" class="pfd-always-print-last" ${state.always_print_last ? "checked" : ""} />
					${__("Always print Last")}
				</label>
			</div>
			<div class="ppd-canvas-stage">
				<div class="ppd-ruler-corner"></div>
				<div class="ppd-ruler-top">${renderRuler("x", state.layout.page_width, 32)}</div>
				<div class="ppd-ruler-left">${renderRuler("y", state.layout.page_height, 24)}</div>
				<div class="ppd-canvas-scroll">
					<div class="pfd-canvas-wrap" style="width:${pageW}px;height:${pageH}px;">
						<div class="pfd-canvas-overlay ppd-blank-page">${elementsHtml}${renderFloatToolbar(selected)}</div>
					</div>
				</div>
				<div class="ppd-zoom-bar">
					${zoomButtons}
					<button type="button" class="ppd-zoom-fit" title="${__("Fit")}">${__("%")}</button>
				</div>
				<div class="ppd-page-pager">
					<button type="button" class="pfd-prev-page" ${state.currentPage <= 0 ? "disabled" : ""}>‹</button>
					<span>${state.currentPage + 1} / ${state.layout.pages.length}</span>
					<button type="button" class="pfd-next-page" ${
						state.currentPage >= state.layout.pages.length - 1 ? "disabled" : ""
					}>›</button>
				</div>
			</div>
		`;
	}

	function renderProperties() {
		const el = getSelectedElement();
		if (!el) {
			return `<div class="pfd-empty-props">${__("Select an element to edit its properties")}</div>`;
		}
		if (el.kind === "field") return renderFieldProperties(el);
		return renderStaticProperties(el);
	}

	function renderGeometryFields(el) {
		return `<div class="pfd-prop-section">
			<div class="pfd-prop-section-title">${__("Position & Size")}</div>
			<div class="pfd-form-row">
				<div class="pfd-form-group">
					<label>${__("X (mm)")}</label>
					<input type="number" class="pfd-prop-x" step="0.01" value="${ptToMm(el.x)}" />
				</div>
				<div class="pfd-form-group">
					<label>${__("Y (mm)")}</label>
					<input type="number" class="pfd-prop-y" step="0.01" value="${ptToMm(el.y)}" />
				</div>
			</div>
			<div class="pfd-form-row">
				<div class="pfd-form-group">
					<label>${__("Width (mm)")}</label>
					<input type="number" class="pfd-prop-width" step="0.01" value="${ptToMm(el.width)}" />
				</div>
				<div class="pfd-form-group">
					<label>${__("Height (mm)")}</label>
					<input type="number" class="pfd-prop-height" step="0.01" value="${ptToMm(el.height)}" />
				</div>
			</div>
		</div>
		<div class="pfd-prop-section">
			<div class="pfd-prop-section-title">${__("Arrange")}</div>
			<div class="ppd-arrange">
				<button type="button" class="ppd-z-forward">${frappe.utils.icon("up-arrow", "xs")}<span>${__(
					"Bring Forward"
				)}</span></button>
				<button type="button" class="ppd-z-backward">${frappe.utils.icon("down-arrow", "xs")}<span>${__(
					"Send Backward"
				)}</span></button>
				<button type="button" class="ppd-z-front">${frappe.utils.icon("expand", "xs")}<span>${__(
					"Bring to Front"
				)}</span></button>
				<button type="button" class="ppd-z-back">${frappe.utils.icon("collapse", "xs")}<span>${__(
					"Send to Back"
				)}</span></button>
			</div>
		</div>
		<button type="button" class="btn btn-danger btn-sm ppd-delete-btn pfd-delete-field">${__(
			"Delete Element"
		)}</button>`;
	}

	function renderStaticProperties(el) {
		const kindLabel = { text: __("Text"), rect: __("Rectangle"), line: __("Line"), image: __("Image") }[
			el.kind
		] || el.kind;
		return `
			<div class="pfd-prop-section">
				<div class="pfd-prop-section-title">${kindLabel}</div>
				${
					el.kind === "text"
						? `<div class="pfd-form-group">
							<label>${__("Text")}</label>
							<textarea class="ppd-prop-text" rows="3">${frappe.utils.escape_html(el.text || "")}</textarea>
						</div>
						<div class="pfd-form-group">
							<label>${__("Font Size")}</label>
							<input type="number" class="pfd-prop-font" min="6" max="72" value="${el.font_size || 12}" />
						</div>
						<div class="pfd-form-group">
							<label>${__("Color")}</label>
							<div class="ppd-color-row">
								<input type="color" class="ppd-prop-color" value="${frappe.utils.escape_html(el.color || "#000000")}" />
								<input type="text" class="ppd-prop-color-hex" value="${frappe.utils.escape_html(el.color || "#000000")}" />
							</div>
						</div>`
						: ""
				}
				${
					el.kind === "rect" || el.kind === "line"
						? `<div class="pfd-form-group">
							<label>${__("Stroke Color")}</label>
							<div class="ppd-color-row">
								<input type="color" class="ppd-prop-stroke" value="${frappe.utils.escape_html(el.stroke || "#000000")}" />
								<input type="text" class="ppd-prop-stroke-hex" value="${frappe.utils.escape_html(el.stroke || "#000000")}" />
							</div>
						</div>
						<div class="pfd-form-group">
							<label>${__("Line Width (pt)")}</label>
							<input type="number" class="ppd-prop-line-width" min="0.25" step="0.25" value="${el.line_width || 1}" />
						</div>
						<div class="pfd-form-group">
							<label>${__("Line Style")}</label>
							<select class="ppd-prop-line-style">
								<option value="solid" ${el.line_style !== "dashed" ? "selected" : ""}>${__("Solid")}</option>
								<option value="dashed" ${el.line_style === "dashed" ? "selected" : ""}>${__("Dashed")}</option>
							</select>
						</div>`
						: ""
				}
				${
					el.kind === "rect"
						? `<div class="pfd-form-group">
							<label>${__("Fill (empty = none)")}</label>
							<input type="text" class="ppd-prop-fill" placeholder="#eeeeee" value="${frappe.utils.escape_html(
								el.fill || ""
							)}" />
						</div>`
						: ""
				}
				${
					el.kind === "image"
						? `<div class="pfd-form-group">
							<label>${__("Image URL")}</label>
							<input type="text" class="ppd-prop-image-url" value="${frappe.utils.escape_html(el.image_url || "")}" />
						</div>`
						: ""
				}
			</div>
			${renderGeometryFields(el)}
		`;
	}

	function renderFieldProperties(field) {
		const showFont = !["Check", "Select", "Barcode", "Image"].includes(field.field_type);
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
						<label>${__("Width (mm)")}</label>
						<input type="number" class="pfd-prop-width" step="0.01" value="${ptToMm(field.width)}" />
					</div>
					<div class="pfd-form-group">
						<label>${__("Height (mm)")}</label>
						<input type="number" class="pfd-prop-height" step="0.01" value="${ptToMm(field.height)}" />
					</div>
				</div>
				<div class="pfd-form-row">
					<div class="pfd-form-group">
						<label>${__("X (mm)")}</label>
						<input type="number" class="pfd-prop-x" step="0.01" value="${ptToMm(field.x)}" />
					</div>
					<div class="pfd-form-group">
						<label>${__("Y (mm)")}</label>
						<input type="number" class="pfd-prop-y" step="0.01" value="${ptToMm(field.y)}" />
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
							<textarea class="pfd-prop-options" rows="3">${frappe.utils.escape_html(field.options || "")}</textarea>
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
			<div class="pfd-prop-section">
				<div class="pfd-panel-title">${__("Repeating row")}</div>
				<div class="pfd-form-group">
					<label>${__("Child Table")}</label>
					<select class="pfd-prop-repeat-table">
						<option value="">${__("None")}</option>
						${(state.child_tables || [])
							.map(
								(table) =>
									`<option value="${frappe.utils.escape_html(table.fieldname)}" ${
										table.fieldname === (field.repeat_table || "") ? "selected" : ""
									}>${frappe.utils.escape_html(table.label || table.fieldname)}</option>`
							)
							.join("")}
					</select>
				</div>
				${
					field.repeat_table
						? `<div class="pfd-form-group">
							<label>${__("Child Field")}</label>
							<select class="pfd-prop-repeat-field">
								<option value="">${__("Select field")}</option>
								${((state.child_tables.find((table) => table.fieldname === field.repeat_table) || {}).fields || [])
									.map(
										(col) =>
											`<option value="${frappe.utils.escape_html(col.fieldname)}" ${
												col.fieldname === (field.repeat_field || field.source_field || "")
													? "selected"
													: ""
											}>${frappe.utils.escape_html(col.label || col.fieldname)}</option>`
									)
									.join("")}
							</select>
						</div>
						<div class="pfd-form-group">
							<label>${__("Rows on this page")}</label>
							<input type="number" class="pfd-prop-repeat-rows" min="1" max="80" value="${
								currentRepeatSlotCount(field.repeat_table) || 1
							}" />
						</div>
						<button type="button" class="btn btn-default btn-sm pfd-tile-rows">${__("Tile rows")}</button>
						<div class="pfd-help-text">${__("Slot {0} is this field’s row on the page.", [
							Number(field.repeat_slot || 0) + 1,
						])}</div>`
						: `<div class="pfd-help-text">${__(
								"Map a child table to print line items. Tile extra slots on this page; Loop clones the page when they overflow."
						  )}</div>`
				}
			</div>
			<button type="button" class="btn btn-danger btn-sm ppd-delete-btn pfd-delete-field">${__("Delete Field")}</button>
		`;
	}

	function render() {
		const app = getAppEl();
		if (!app) return;
		app.innerHTML = `
			<div class="ppd-app">
				<div class="ppd-topbar">
					<div>
						<div class="ppd-title-row">
							<h1>${frappe.utils.escape_html(state.title || __("PDF Print Designer"))}</h1>
							<span class="ppd-badge">${__("PDF Print Design")}</span>
						</div>
						<div class="ppd-subtitle">${__("Design blank-page PDF for {0}", [
							state.reference_doctype || "",
						])}</div>
					</div>
					<div class="ppd-topbar-actions">
						<span class="ppd-unsaved${state.dirty ? "" : " is-saved"}">${
							state.dirty ? __("Not Saved") : __("Saved")
						}</span>
						<button type="button" class="btn btn-default btn-sm pfd-preview-btn">${__("Preview")}</button>
						<button type="button" class="btn btn-default btn-sm pfd-cancel-btn">${__("Back")}</button>
						<button type="button" class="btn btn-primary btn-sm pfd-save-btn">${__("Save Design")}</button>
					</div>
				</div>
				<div class="ppd-body">
					<aside class="ppd-left">
						<div class="ppd-tabs">
							<button type="button" class="ppd-tab${
								state.leftTab === "elements" ? " is-active" : ""
							}" data-tab="elements">${__("Elements")}</button>
							<button type="button" class="ppd-tab${
								state.leftTab === "fields" ? " is-active" : ""
							}" data-tab="fields">${__("Fields")}</button>
						</div>
						<div class="ppd-tab-body">${renderLeftPanel()}</div>
					</aside>
					<main class="ppd-center pfd-canvas-container">${renderCanvas()}</main>
					<aside class="ppd-right">
						<div class="ppd-props-head">${__("Properties")}</div>
						<div class="pfd-properties">${renderProperties()}</div>
					</aside>
				</div>
			</div>
		`;
		bindEvents(app);
		renderBarcodePreviews(app);
	}

	function renderCanvasContainer() {
		const container = document.querySelector(".pfd-canvas-container");
		if (!container) return;
		container.innerHTML = renderCanvas();
		bindCanvasEvents(container);
		renderBarcodePreviews(container);
	}

	function renderBarcodePreviews(root = document) {
		const previews = root.querySelectorAll(".pfd-barcode-preview");
		if (!previews.length) return;
		const draw = () => {
			previews.forEach((svg) => {
				const value = (svg.dataset.barcodeValue || "").trim() || "1234567890";
				try {
					JsBarcode(svg, value, {
						format: "CODE128",
						displayValue: false,
						margin: 0,
						height: 32,
					});
				} catch (err) {
					// ignore invalid preview values
				}
			});
		};
		if (typeof JsBarcode !== "undefined") {
			draw();
			return;
		}
		frappe.require("/assets/frappe/js/lib/JsBarcode.all.min.js", draw);
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
		if (!container) return;
		container.querySelectorAll(".pfd-ref-field:not(.pfd-child-field)").forEach((item) => {
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
		app.querySelector(".pfd-preview-btn")?.addEventListener("click", previewWithDocument);
		app.querySelector(".pfd-cancel-btn")?.addEventListener("click", () => {
			if (state.dirty && !confirm(__("Discard unsaved changes?"))) return;
			frappe.set_route("Form", "PDF Print Design", state.designName);
		});
		app.querySelectorAll(".ppd-tab").forEach((tab) => {
			tab.addEventListener("click", () => {
				state.leftTab = tab.dataset.tab;
				render();
			});
		});
		app.querySelectorAll(".ppd-tool").forEach((item) => {
			item.addEventListener("dragstart", (e) => {
				if (item.dataset.drawKind) {
					e.dataTransfer.setData("text/ppd-draw-kind", item.dataset.drawKind);
					state.activeTool = item.dataset.drawKind;
				} else if (item.dataset.type) {
					e.dataTransfer.setData("text/pfd-field-type", item.dataset.type);
				} else if (item.dataset.childRow) {
					e.dataTransfer.setData("text/ppd-child-row", "1");
				}
				e.dataTransfer.effectAllowed = "copy";
			});
			item.addEventListener("click", () => {
				if (item.dataset.drawKind) {
					state.activeTool = state.activeTool === item.dataset.drawKind ? "" : item.dataset.drawKind;
					app.querySelectorAll(".ppd-tool[data-draw-kind]").forEach((el) => {
						el.classList.toggle("is-active", el.dataset.drawKind === state.activeTool);
					});
					return;
				}
				if (item.dataset.type) {
					addField(item.dataset.type, 72, 80);
					return;
				}
				if (item.dataset.childRow) addChildTableRow();
			});
		});
		app.querySelector(".pfd-field-filter")?.addEventListener("input", (e) => {
			state.fieldFilter = e.target.value;
			renderReferenceFieldsPanel();
		});
		bindReferenceFieldEvents(app.querySelector(".pfd-ref-fields"));
		bindChildTableEvents(app);
		bindCanvasEvents(app.querySelector(".pfd-canvas-container"));
		bindPropertyEvents(app.querySelector(".pfd-properties"));
	}

	function bindChildTableEvents(container) {
		if (!container) return;
		container.querySelectorAll(".pfd-child-field").forEach((item) => {
			item.addEventListener("click", () => {
				const table = (state.child_tables || []).find((row) => row.fieldname === item.dataset.table);
				if (!table) return;
				mapChildField(table, {
					fieldname: item.dataset.fieldname,
					fieldtype: item.dataset.fieldtype,
				});
			});
		});
	}

	function bindCanvasEvents(container) {
		if (!container) return;
		container.querySelectorAll(".pfd-prev-page").forEach((btn) => {
			btn.addEventListener("click", () => {
				if (state.currentPage > 0) {
					state.currentPage -= 1;
					state.selectedId = null;
					renderCanvasContainer();
					renderPropertiesPanel();
				}
			});
		});
		container.querySelectorAll(".pfd-next-page").forEach((btn) => {
			btn.addEventListener("click", () => {
				if (state.currentPage < state.layout.pages.length - 1) {
					state.currentPage += 1;
					state.selectedId = null;
					renderCanvasContainer();
					renderPropertiesPanel();
				}
			});
		});
		container.querySelector(".pfd-page-role")?.addEventListener("change", (e) => {
			const page = getCurrentPage();
			if (!page) return;
			page.role = e.target.value;
			markDirty();
		});
		container.querySelector(".ppd-add-page")?.addEventListener("click", addPage);
		container.querySelector(".ppd-remove-page")?.addEventListener("click", removePage);
		container.querySelector(".ppd-paper-select")?.addEventListener("change", (e) => {
			setPaperSize(e.target.value);
		});
		container.querySelector(".ppd-custom-width")?.addEventListener("change", (e) => {
			state.layout.page_width = Math.max(72, parseFloat(e.target.value) || 72);
			markDirty();
			renderCanvasContainer();
		});
		container.querySelector(".ppd-custom-height")?.addEventListener("change", (e) => {
			state.layout.page_height = Math.max(72, parseFloat(e.target.value) || 72);
			markDirty();
			renderCanvasContainer();
		});
		container.querySelector(".ppd-page-select")?.addEventListener("change", (e) => {
			state.currentPage = parseInt(e.target.value, 10) || 0;
			state.selectedId = null;
			renderCanvasContainer();
			renderPropertiesPanel();
		});
		container.querySelector(".pfd-always-print-last")?.addEventListener("change", (e) => {
			state.always_print_last = e.target.checked ? 1 : 0;
			markDirty();
		});
		container.querySelectorAll(".ppd-zoom-preset").forEach((btn) => {
			btn.addEventListener("click", () => setZoom(parseFloat(btn.dataset.zoom) || 0.5));
		});
		container.querySelector(".ppd-zoom-fit")?.addEventListener("click", zoomToFit);
		container.querySelector(".ppd-dup-btn")?.addEventListener("click", (e) => {
			e.stopPropagation();
			duplicateSelected();
		});
		container.querySelector(".ppd-delete-float")?.addEventListener("click", (e) => {
			e.stopPropagation();
			deleteSelected();
		});

		const overlay = container.querySelector(".pfd-canvas-overlay");
		if (!overlay) return;
		overlay.addEventListener("dragover", (e) => {
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
			overlay.classList.add("pfd-drop-over");
		});
		overlay.addEventListener("dragleave", () => overlay.classList.remove("pfd-drop-over"));
		overlay.addEventListener("drop", (e) => {
			e.preventDefault();
			overlay.classList.remove("pfd-drop-over");
			justDropped = true;
			setTimeout(() => {
				justDropped = false;
			}, 50);
			const rect = overlay.getBoundingClientRect();
			const x = pxToPt(e.clientX - rect.left);
			const y = pxToPt(e.clientY - rect.top);
			const refPayload = e.dataTransfer.getData("text/pfd-ref-field");
			if (refPayload) {
				try {
					mapReferenceField(JSON.parse(refPayload));
				} catch (err) {
					// ignore
				}
				return;
			}
			const drawKind = e.dataTransfer.getData("text/ppd-draw-kind");
			if (drawKind) {
				addDrawElement(drawKind, x, y);
				return;
			}
			if (e.dataTransfer.getData("text/ppd-child-row")) {
				addChildTableRow();
				return;
			}
			const type = e.dataTransfer.getData("text/pfd-field-type");
			if (type) addField(type, x, y);
		});
		overlay.addEventListener("mousedown", onOverlayMouseDown);
		overlay.addEventListener("click", (e) => {
			if (e.target !== overlay) return;
			if (justDropped) return;
			if (state.activeTool) {
				const rect = overlay.getBoundingClientRect();
				addDrawElement(state.activeTool, pxToPt(e.clientX - rect.left), pxToPt(e.clientY - rect.top));
				return;
			}
			state.selectedId = null;
			renderPropertiesPanel();
			renderCanvasContainer();
		});
	}

	function bindPropertyEvents(panel) {
		if (!panel) return;
		panel.querySelector(".ppd-prop-text")?.addEventListener("input", (e) => {
			updateSelected({ text: e.target.value }, { refreshCanvas: true });
		});
		panel.querySelector(".ppd-prop-color")?.addEventListener("input", (e) => {
			updateSelected({ color: e.target.value }, { refreshCanvas: true });
		});
		panel.querySelector(".ppd-prop-stroke")?.addEventListener("input", (e) => {
			updateSelected({ stroke: e.target.value }, { refreshCanvas: true, refreshProperties: true });
		});
		panel.querySelector(".ppd-prop-stroke-hex")?.addEventListener("change", (e) => {
			updateSelected({ stroke: e.target.value }, { refreshCanvas: true, refreshProperties: true });
		});
		panel.querySelector(".ppd-prop-color-hex")?.addEventListener("change", (e) => {
			updateSelected({ color: e.target.value }, { refreshCanvas: true, refreshProperties: true });
		});
		panel.querySelector(".ppd-prop-line-style")?.addEventListener("change", (e) => {
			updateSelected({ line_style: e.target.value }, { refreshCanvas: true });
		});
		panel.querySelector(".ppd-z-forward")?.addEventListener("click", () => moveSelectedZ("forward"));
		panel.querySelector(".ppd-z-backward")?.addEventListener("click", () => moveSelectedZ("backward"));
		panel.querySelector(".ppd-z-front")?.addEventListener("click", () => moveSelectedZ("front"));
		panel.querySelector(".ppd-z-back")?.addEventListener("click", () => moveSelectedZ("back"));
		panel.querySelector(".ppd-prop-fill")?.addEventListener("input", (e) => {
			updateSelected({ fill: e.target.value }, { refreshCanvas: true });
		});
		panel.querySelector(".ppd-prop-line-width")?.addEventListener("change", (e) => {
			updateSelected({ line_width: parseFloat(e.target.value) || 1 }, { refreshCanvas: true });
		});
		panel.querySelector(".ppd-prop-image-url")?.addEventListener("input", (e) => {
			updateSelected({ image_url: e.target.value }, { refreshCanvas: true });
		});
		panel.querySelector(".pfd-prop-name")?.addEventListener("input", (e) => {
			updateSelected({ field_name: e.target.value }, { refreshCanvas: true });
		});
		panel.querySelector(".pfd-prop-type")?.addEventListener("change", (e) => {
			const spec = FIELD_TYPES.find((item) => item.type === e.target.value);
			const updates = { field_type: e.target.value };
			if (spec && e.target.value === "Date") updates.date_format = spec.date_format || "%d-%m-%Y";
			if (spec && e.target.value === "Select" && !getSelectedElement()?.options) {
				updates.options = spec.options || "";
			}
			updateSelected(updates, { refreshCanvas: true, refreshProperties: true });
		});
		panel.querySelector(".pfd-prop-font")?.addEventListener("input", (e) => {
			updateSelected({ font_size: parseFloat(e.target.value) || 10 }, { refreshCanvas: true });
		});
		panel.querySelector(".pfd-prop-width")?.addEventListener("change", (e) => {
			updateSelected({ width: mmToPt(e.target.value) }, { refreshCanvas: true });
		});
		panel.querySelector(".pfd-prop-height")?.addEventListener("change", (e) => {
			updateSelected({ height: mmToPt(e.target.value) }, { refreshCanvas: true });
		});
		panel.querySelector(".pfd-prop-x")?.addEventListener("change", (e) => {
			updateSelected({ x: Math.max(0, mmToPt(e.target.value)) }, { refreshCanvas: true });
		});
		panel.querySelector(".pfd-prop-y")?.addEventListener("change", (e) => {
			updateSelected({ y: Math.max(0, mmToPt(e.target.value)) }, { refreshCanvas: true });
		});
		panel.querySelector(".pfd-prop-source-type")?.addEventListener("change", (e) => {
			updateSelected({ source_type: e.target.value }, { refreshProperties: true });
		});
		panel.querySelector(".pfd-prop-source-field")?.addEventListener("input", (e) => {
			updateSelected({ source_field: e.target.value }, { refreshCanvas: true });
		});
		panel.querySelector(".pfd-prop-jinja-script")?.addEventListener("input", (e) => {
			updateSelected({ jinja_script: e.target.value });
		});
		panel.querySelector(".pfd-prop-default-value")?.addEventListener("input", (e) => {
			updateSelected({ default_value: e.target.value }, { refreshCanvas: true });
		});
		panel.querySelector(".pfd-prop-date-format")?.addEventListener("change", (e) => {
			updateSelected({ date_format: e.target.value });
		});
		panel.querySelector(".pfd-prop-options")?.addEventListener("input", (e) => {
			updateSelected({ options: e.target.value });
		});
		panel.querySelector(".pfd-prop-editable")?.addEventListener("change", (e) => {
			updateSelected({ editable: e.target.checked ? 1 : 0 });
		});
		panel.querySelector(".pfd-prop-repeat-table")?.addEventListener("change", (e) => {
			const table = e.target.value;
			updateSelected(
				{
					repeat_table: table,
					repeat_field: table ? getSelectedElement()?.repeat_field || "" : "",
					repeat_slot: table ? Number(getSelectedElement()?.repeat_slot || 0) : 0,
				},
				{ refreshCanvas: true, refreshProperties: true }
			);
		});
		panel.querySelector(".pfd-prop-repeat-field")?.addEventListener("change", (e) => {
			updateSelected(
				{
					repeat_field: e.target.value,
					source_field: e.target.value || getSelectedElement()?.source_field || "",
				},
				{ refreshCanvas: true }
			);
		});
		panel.querySelector(".pfd-tile-rows")?.addEventListener("click", () => {
			const input = panel.querySelector(".pfd-prop-repeat-rows");
			tileRepeatRows(input ? input.value : 1);
		});
		panel.querySelector(".pfd-delete-field")?.addEventListener("click", deleteSelected);
	}

	function findElement(id) {
		for (const page of state.layout.pages || []) {
			const found = (page.elements || []).find((el) => el.id === id);
			if (found) return found;
		}
		return null;
	}

	function onOverlayMouseDown(e) {
		const elNode = e.target.closest("[data-element-id]");
		if (!elNode) return;
		e.preventDefault();
		e.stopPropagation();
		const field = findElement(elNode.dataset.elementId);
		if (!field) return;
		state.selectedId = field.id;
		renderPropertiesPanel();
		renderCanvasContainer();
		const isResize = e.target.dataset.resize === "1";
		const endpoint = e.target.dataset.endpoint || "";
		dragState = {
			field,
			isResize,
			endpoint,
			startX: e.clientX,
			startY: e.clientY,
			startField: { ...field },
		};
		document.addEventListener("mousemove", onDocumentMouseMove);
		document.addEventListener("mouseup", onDocumentMouseUp);
	}

	function onDocumentMouseMove(moveEvent) {
		if (!dragState) return;
		const dx = pxToPt(moveEvent.clientX - dragState.startX);
		const dy = pxToPt(moveEvent.clientY - dragState.startY);
		const pageW = state.layout.page_width;
		const pageH = state.layout.page_height;
		if (dragState.endpoint === "end" || dragState.endpoint === "start") {
			const start = dragState.startField;
			if (dragState.endpoint === "end") {
				dragState.field.width = start.width + dx;
				let height = start.height + dy;
				if (Math.abs(height) < 3) height = 0;
				dragState.field.height = height;
			} else {
				dragState.field.x = start.x + dx;
				dragState.field.y = start.y + dy;
				dragState.field.width = start.width - dx;
				let height = start.height - dy;
				if (Math.abs(height) < 3) height = 0;
				dragState.field.height = height;
			}
		} else if (dragState.isResize) {
			const width = Math.max(MIN_WIDTH_PT, dragState.startField.width + dx);
			const height = Math.max(MIN_HEIGHT_PT, dragState.startField.height + dy);
			dragState.field.width = Math.min(width, pageW - dragState.startField.x);
			dragState.field.height = Math.min(height, pageH - dragState.startField.y);
		} else {
			const hitH =
				dragState.startField.kind === "line"
					? Math.max(Math.abs(dragState.startField.height), 8)
					: dragState.startField.height;
			const maxX = pageW - Math.abs(dragState.startField.width);
			const maxY = pageH - hitH;
			dragState.field.x = clamp(dragState.startField.x + dx, 0, maxX);
			dragState.field.y = clamp(dragState.startField.y + dy, 0, maxY);
		}
		markDirty();
		renderCanvasContainer();
	}

	function onDocumentMouseUp() {
		if (dragState) {
			justDropped = true;
			setTimeout(() => {
				justDropped = false;
			}, 50);
		}
		document.removeEventListener("mousemove", onDocumentMouseMove);
		document.removeEventListener("mouseup", onDocumentMouseUp);
		dragState = null;
	}

	function onKeyDown(e) {
		const tag = (e.target && e.target.tagName) || "";
		if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
		if (e.key === "Escape") {
			state.activeTool = "";
			state.selectedId = null;
			render();
			return;
		}
		if (!state.selectedId) return;
		if (e.key === "Delete" || e.key === "Backspace") {
			e.preventDefault();
			deleteSelected();
		}
	}

	function refresh() {
		const app = getAppEl();
		if (!app) return;
		const designName = getDesignName();
		if (!designName) {
			showMessage(__("Open a PDF Print Design and click Design Page."));
			return;
		}
		if (state.designName === designName && state.layout.pages.length) {
			state.scale = getScale();
			render();
			return;
		}
		showMessage(__("Loading designer…"));
		loadContext(designName);
	}

	pdffiller.print_designer.setup_page = function (wrapper) {
		pageInstance = frappe.ui.make_app_page({
			parent: wrapper,
			title: __("PDF Print Designer"),
			single_column: true,
		});
		pageInstance.main
			.addClass("pdffiller-designer-page")
			.html('<div id="pdffiller-print-designer-app" class="pdffiller-designer-root"></div>');
		$(wrapper).addClass("page-pdf-print-designer");
		$(wrapper).find(".page-head").hide();
		$(wrapper)
			.find(".page-body, .layout-main-section-wrapper, .layout-main-section")
			.css({ padding: 0, margin: 0 });
		refresh();
	};

	pdffiller.print_designer.refresh = refresh;
	document.addEventListener("keydown", onKeyDown);
	window.addEventListener("beforeunload", (e) => {
		if (state.dirty) e.preventDefault();
	});
})();
