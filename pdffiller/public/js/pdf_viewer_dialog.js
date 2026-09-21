/* Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors */

frappe.provide("pdffiller.viewer");

(function () {
	"use strict";

	function download_pdf(data_uri, filename) {
		const link = document.createElement("a");
		link.href = data_uri;
		link.download = filename || "form.pdf";
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	}

	function print_pdf(data_uri) {
		const print_window = window.open(data_uri);
		if (!print_window) {
			frappe.msgprint({
				title: __("Pop-up Blocked"),
				message: __("Please allow pop-ups to print this PDF."),
				indicator: "orange",
			});
			return;
		}
		print_window.addEventListener("load", function () {
			print_window.focus();
			print_window.print();
		});
	}

	function render_field_input(field) {
		const value = frappe.utils.escape_html(field.value || "");
		const label = frappe.utils.escape_html(field.pdf_field_name);
		if (field.editable) {
			return `
				<div class="form-group pdffiller-field-group">
					<label class="control-label">${label}</label>
					<input
						type="text"
						class="form-control input-sm pdffiller-field-input"
						data-field-name="${frappe.utils.escape_html(field.pdf_field_name)}"
						value="${value}"
					/>
				</div>
			`;
		}
		return `
			<div class="form-group pdffiller-field-group pdffiller-field-readonly">
				<label class="control-label text-muted">${label}</label>
				<div class="pdffiller-readonly-value">${value || __("Empty")}</div>
			</div>
		`;
	}

	function render_form_panel(fields) {
		const editable_count = fields.filter((field) => field.editable).length;
		const has_editable = editable_count > 0;
		const fields_html = fields.map(render_field_input).join("");

		return `
			<div class="pdffiller-form-panel">
				<div class="pdffiller-form-panel-header">
					<button type="button" class="btn btn-default btn-xs pdffiller-form-panel-toggle" title="${__(
						"Field Values"
					)}">
						${frappe.utils.icon("right", "xs", "pdffiller-form-panel-toggle-icon")}
						<span class="pdffiller-form-panel-toggle-label">${__("Field Values")}</span>
					</button>
					<div class="pdffiller-form-panel-actions">
						${
							has_editable
								? `<button type="button" class="btn btn-primary btn-sm pdffiller-refresh-btn">
									${__("Update PDF")}
								</button>`
								: `<span class="text-muted small pdffiller-readonly-note">${__(
										"All fields are read-only"
								  )}</span>`
						}
					</div>
				</div>
				<div class="pdffiller-form-fields">
					${fields_html || `<p class="text-muted">${__("No mapped fields found.")}</p>`}
				</div>
			</div>
		`;
	}

	function render_preview_shell() {
		return `
			<div class="pdffiller-viewer">
				<div class="pdffiller-viewer-toolbar">
					<label class="pdffiller-fields-only-toggle">
						<input type="checkbox" class="pdffiller-fields-only-checkbox" />
						<span>${__("Fields only (no background)")}</span>
					</label>
					<div class="pdffiller-viewer-toolbar-actions">
						<button type="button" class="btn btn-default btn-sm pdffiller-print-btn" disabled>
							${__("Print")}
						</button>
						<button type="button" class="btn btn-primary btn-sm pdffiller-download-btn" disabled>
							${__("Download")}
						</button>
					</div>
				</div>
				<div class="pdffiller-viewer-body">
					<div class="pdffiller-form-wrapper"></div>
					<div class="pdffiller-viewer-frame">
						<div class="pdffiller-loading text-muted">${__("Generating PDF...")}</div>
					</div>
				</div>
			</div>
		`;
	}

	function render_pdf_frame($frame, data_uri) {
		const html = `
			<object style="background:#323639;" width="100%" height="100%">
				<embed
					style="background:#323639;"
					width="100%"
					height="100%"
					src="${frappe.utils.escape_html(data_uri)}"
					type="application/pdf"
				/>
			</object>
		`;
		$frame.html(html);
	}

	function collect_overrides($wrapper, fields) {
		const overrides = {};
		fields.forEach(function (field) {
			if (!field.editable) return;
			const $input = $wrapper.find(
				`.pdffiller-field-input[data-field-name="${CSS.escape(field.pdf_field_name)}"]`
			);
			if ($input.length) {
				overrides[field.pdf_field_name] = $input.val();
			}
		});
		return overrides;
	}

	function bind_preview_actions($viewer, state, reload) {
		$viewer.find(".pdffiller-print-btn").off("click").on("click", function () {
			if (!state.payload) return;
			print_pdf(state.payload.data_uri);
		});

		$viewer.find(".pdffiller-download-btn").off("click").on("click", function () {
			if (!state.payload) return;
			download_pdf(state.payload.data_uri, state.payload.filename);
		});

		$viewer.find(".pdffiller-refresh-btn").off("click").on("click", function () {
			reload();
		});

		$viewer.find(".pdffiller-fields-only-checkbox").off("change").on("change", function () {
			state.fields_only = $(this).is(":checked");
			reload();
		});

		$viewer.find(".pdffiller-form-panel-toggle").off("click").on("click", function () {
			$viewer
				.find(".pdffiller-form-wrapper")
				.toggleClass("pdffiller-form-wrapper--collapsed");
		});

		$viewer.find(".pdffiller-field-input").off("keydown").on("keydown", function (event) {
			if (event.key === "Enter") {
				event.preventDefault();
				reload();
			}
		});
	}

	function apply_payload($viewer, state, payload) {
		if (payload.fields) {
			state.fields = payload.fields;
			const collapsed = $viewer
				.find(".pdffiller-form-wrapper")
				.hasClass("pdffiller-form-wrapper--collapsed");
			$viewer.find(".pdffiller-form-wrapper").html(render_form_panel(state.fields));
			if (collapsed) {
				$viewer.find(".pdffiller-form-wrapper").addClass("pdffiller-form-wrapper--collapsed");
			}
		}
		if (payload.fields_only !== undefined) {
			state.fields_only = Boolean(payload.fields_only);
			$viewer.find(".pdffiller-fields-only-checkbox").prop("checked", state.fields_only);
		}
		state.payload = payload;
		render_pdf_frame($viewer.find(".pdffiller-viewer-frame"), payload.data_uri);
		$viewer.find(".pdffiller-print-btn, .pdffiller-download-btn").prop("disabled", false);
	}

	function bind_viewer_actions($viewer, state, frm, template_name, source) {
		bind_preview_actions($viewer, state, function () {
			load_filled_pdf($viewer, state, frm, template_name, source);
		});
	}

	function load_filled_pdf($viewer, state, frm, template_name, source) {
		const overrides = collect_overrides($viewer, state.fields || []);
		const $frame = $viewer.find(".pdffiller-viewer-frame");
		$frame.html(`<div class="pdffiller-loading text-muted">${__("Generating PDF...")}</div>`);
		$viewer.find(".pdffiller-print-btn, .pdffiller-download-btn").prop("disabled", true);

		frappe.call({
			method: "pdffiller.api.forms.get_filled_pdf",
			args: {
				template: template_name,
				doctype: frm.doctype,
				name: frm.doc.name,
				field_overrides: overrides,
				fields_only: state.fields_only ? 1 : 0,
				source: source || "form_template",
			},
			freeze: true,
			callback(r) {
				if (!r.message || !r.message.data_uri) {
					frappe.msgprint({
						title: __("Error"),
						message: __("Could not generate the filled PDF."),
						indicator: "red",
					});
					return;
				}

				apply_payload($viewer, state, r.message);
			},
		});
	}

	pdffiller.viewer.open_preview = function (opts) {
		opts = opts || {};
		const dialog = new frappe.ui.Dialog({
			title: opts.title || __("PDF Form"),
			size: "extra-large",
			fields: [
				{
					fieldtype: "HTML",
					fieldname: "pdf_preview",
				},
			],
		});

		const state = {
			fields: opts.fields || [],
			payload: null,
			fields_only: Boolean(opts.fields_only),
		};
		dialog.show();
		dialog.$wrapper.find(".modal-body").addClass("pdffiller-dialog-body");

		const $preview = dialog.fields_dict.pdf_preview.$wrapper;
		$preview.html(render_preview_shell());
		const $viewer = $preview.find(".pdffiller-viewer").first();
		$viewer.find(".pdffiller-fields-only-checkbox").prop("checked", state.fields_only);
		$viewer
			.find(".pdffiller-form-wrapper")
			.addClass("pdffiller-form-wrapper--collapsed")
			.html(render_form_panel(state.fields));

		function reload() {
			if (typeof opts.load !== "function") {
				return;
			}
			state.overrides = collect_overrides($viewer, state.fields || []);
			const $frame = $viewer.find(".pdffiller-viewer-frame");
			$frame.html(`<div class="pdffiller-loading text-muted">${__("Generating PDF...")}</div>`);
			$viewer.find(".pdffiller-print-btn, .pdffiller-download-btn").prop("disabled", true);
			opts.load(state, function (payload) {
				if (!payload || !payload.data_uri) {
					frappe.msgprint({
						title: __("Error"),
						message: __("Could not generate the filled PDF."),
						indicator: "red",
					});
					return;
				}
				apply_payload($viewer, state, payload);
				bind_preview_actions($viewer, state, reload);
			});
		}

		bind_preview_actions($viewer, state, reload);
		reload();
		return dialog;
	};

	pdffiller.viewer.open = function (frm, template_name, template_title, source) {
		const dialog = new frappe.ui.Dialog({
			title: template_title || __("PDF Form"),
			size: "extra-large",
			fields: [
				{
					fieldtype: "HTML",
					fieldname: "pdf_preview",
				},
			],
		});

		const form_source = source || "form_template";
		const state = { fields: [], payload: null, fields_only: false };
		dialog.show();
		dialog.$wrapper.find(".modal-body").addClass("pdffiller-dialog-body");

		const $preview = dialog.fields_dict.pdf_preview.$wrapper;
		$preview.html(render_preview_shell());
		const $viewer = $preview.find(".pdffiller-viewer").first();
		if (form_source === "print_design") {
			$viewer.find(".pdffiller-fields-only-toggle").hide();
		}

		frappe.call({
			method: "pdffiller.api.forms.get_form_preview",
			args: {
				template: template_name,
				doctype: frm.doctype,
				name: frm.doc.name,
				source: form_source,
			},
			freeze: true,
			callback(r) {
				if (!r.message) {
					dialog.hide();
					frappe.msgprint({
						title: __("Error"),
						message: __("Could not load the PDF form preview."),
						indicator: "red",
					});
					return;
				}

				state.fields = r.message.fields || [];
				state.fields_only = Boolean(r.message.fields_only);
				$viewer
					.find(".pdffiller-fields-only-checkbox")
					.prop("checked", state.fields_only);
				const $form_wrapper = $viewer.find(".pdffiller-form-wrapper");
				$form_wrapper
					.addClass("pdffiller-form-wrapper--collapsed")
					.html(render_form_panel(state.fields));
				bind_viewer_actions($viewer, state, frm, template_name, form_source);
				load_filled_pdf($viewer, state, frm, template_name, form_source);
			},
			error() {
				dialog.hide();
			},
		});
	};
})();
