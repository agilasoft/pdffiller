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
		const label = field.form
			? `${frappe.utils.escape_html(field.form)} · ${frappe.utils.escape_html(field.pdf_field_name)}`
			: frappe.utils.escape_html(field.pdf_field_name);
		if (field.field_type === "Signature" && field.editable) {
			return `
				<div class="form-group pdffiller-field-group">
					<label class="control-label">${label}</label>
					<canvas class="pdffiller-signature" width="280" height="90" data-field-name="${frappe.utils.escape_html(
						field.pdf_field_name
					)}"></canvas>
					<input type="hidden" class="pdffiller-field-input" data-field-name="${frappe.utils.escape_html(
						field.pdf_field_name
					)}" />
					<button type="button" class="btn btn-default btn-xs pdffiller-signature-clear">${__(
						"Clear signature"
					)}</button>
				</div>
			`;
		}
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

	function has_editable_fields(fields) {
		return (fields || []).some(function (field) {
			return Boolean(field && field.editable);
		});
	}

	function render_form_panel(fields) {
		const editable_count = (fields || []).filter((field) => field.editable).length;
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
						<button type="button" class="btn btn-default btn-sm pdffiller-attach-btn" disabled>
							${__("Attach")}
						</button>
						<button type="button" class="btn btn-default btn-sm pdffiller-email-btn" disabled>
							${__("Email")}
						</button>
						<button type="button" class="btn btn-primary btn-sm pdffiller-download-btn" disabled>
							${__("Download")}
						</button>
					</div>
				</div>
				<div class="pdffiller-warnings-host"></div>
				<div class="pdffiller-viewer-body">
					<div class="pdffiller-form-wrapper pdffiller-form-wrapper--collapsed"></div>
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
				if ($input.attr("type") === "hidden" && !$input.data("touched")) return;
				overrides[field.pdf_field_name] = $input.val();
			}
		});
		return overrides;
	}

	function show_warnings($viewer, warnings) {
		const host = $viewer.find(".pdffiller-warnings-host");
		if (!warnings || !warnings.length) {
			host.empty();
			return;
		}
		const items = warnings
			.map(function (warning) {
				const field = warning.field
					? `<b>${frappe.utils.escape_html(warning.field)}</b>: `
					: "";
				return `<li>${field}${frappe.utils.escape_html(warning.message || "")}</li>`;
			})
			.join("");
		host.html(
			`<div class="pdffiller-warnings">${__("Some values could not be filled")}<ul>${items}</ul></div>`
		);
	}

	function bind_signature_pads($viewer) {
		$viewer.find(".pdffiller-signature").each(function () {
			const canvas = this;
			if (canvas.dataset.bound) return;
			canvas.dataset.bound = "1";
			const field_name = canvas.dataset.fieldName;
			const input = $viewer.find(
				`.pdffiller-field-input[data-field-name="${CSS.escape(field_name)}"]`
			)[0];
			const ctx = canvas.getContext("2d");
			ctx.strokeStyle = "#111";
			ctx.lineWidth = 1.6;
			ctx.lineCap = "round";
			let drawing = false;

			function point(event) {
				const rect = canvas.getBoundingClientRect();
				return {
					x: (event.clientX - rect.left) * (canvas.width / rect.width),
					y: (event.clientY - rect.top) * (canvas.height / rect.height),
				};
			}

			canvas.addEventListener("pointerdown", function (event) {
				drawing = true;
				canvas.setPointerCapture(event.pointerId);
				const p = point(event);
				ctx.beginPath();
				ctx.moveTo(p.x, p.y);
			});
			canvas.addEventListener("pointermove", function (event) {
				if (!drawing) return;
				const p = point(event);
				ctx.lineTo(p.x, p.y);
				ctx.stroke();
			});
			function finish() {
				if (!drawing) return;
				drawing = false;
				if (input) {
					input.value = canvas.toDataURL("image/png");
					$(input).data("touched", 1);
				}
			}
			canvas.addEventListener("pointerup", finish);
			canvas.addEventListener("pointercancel", finish);

			if (input && input.value && input.value.indexOf("data:image") === 0) {
				const image = new Image();
				image.onload = function () {
					ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
				};
				image.src = input.value;
			}
		});

		$viewer.find(".pdffiller-signature-clear").off("click").on("click", function () {
			const group = $(this).closest(".pdffiller-field-group");
			const canvas = group.find(".pdffiller-signature")[0];
			const input = group.find(".pdffiller-field-input")[0];
			if (canvas) {
				const ctx = canvas.getContext("2d");
				ctx.clearRect(0, 0, canvas.width, canvas.height);
			}
			if (input) {
				input.value = "";
				$(input).data("touched", 1);
			}
		});
	}

	function open_email_composer(frm, file_doc, subject) {
		const open = function () {
			if (!frappe.views || !frappe.views.CommunicationComposer) {
				frappe.msgprint(__("Email is not available on this desk."));
				return;
			}
			new frappe.views.CommunicationComposer({
				doc: frm.doc,
				frm: frm,
				subject: subject,
				recipients: frm.doc.email_id || frm.doc.contact_email || frm.doc.email || "",
				attachments: file_doc ? [file_doc] : [],
			});
		};
		if (frm && frm.reload_doc) {
			frm.reload_doc().then(open);
		} else {
			open();
		}
	}

	function save_attachment($viewer, state, purpose) {
		if (!state.frm || !state.template_name) return;
		const overrides = collect_overrides($viewer, state.fields || []);
		frappe.call({
			method: "pdffiller.api.forms.attach_filled_pdf",
			args: {
				template: state.template_name,
				doctype: state.frm.doctype,
				name: state.frm.doc.name,
				field_overrides: overrides,
				fields_only: state.fields_only ? 1 : 0,
				source: state.source || "form_template",
				purpose: purpose || "attach",
			},
			freeze: true,
			callback(r) {
				const file_doc = r.message || {};
				show_warnings($viewer, file_doc.warnings);
				if (purpose === "email") {
					open_email_composer(state.frm, file_doc, file_doc.subject);
					return;
				}
				frappe.show_alert({
					message: __("Attached {0}", [file_doc.file_name || file_doc.filename || ""]),
					indicator: "green",
				});
				if (state.frm.reload_doc) state.frm.reload_doc();
			},
		});
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

		$viewer.find(".pdffiller-attach-btn").off("click").on("click", function () {
			save_attachment($viewer, state, "attach");
		});

		$viewer.find(".pdffiller-email-btn").off("click").on("click", function () {
			save_attachment($viewer, state, "email");
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

		bind_signature_pads($viewer);
		const can_save = Boolean(state.frm);
		$viewer.find(".pdffiller-attach-btn, .pdffiller-email-btn").toggle(can_save);
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
		show_warnings($viewer, payload.warnings);
		render_pdf_frame($viewer.find(".pdffiller-viewer-frame"), payload.data_uri);
		$viewer
			.find(".pdffiller-print-btn, .pdffiller-download-btn, .pdffiller-attach-btn, .pdffiller-email-btn")
			.prop("disabled", false);
		bind_signature_pads($viewer);
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
		$viewer
			.find(".pdffiller-print-btn, .pdffiller-download-btn, .pdffiller-attach-btn, .pdffiller-email-btn")
			.prop("disabled", true);

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
			frm: opts.frm || null,
			template_name: opts.template || null,
			source: opts.source || "form_template",
		};
		dialog.show();
		dialog.$wrapper.find(".modal-body").addClass("pdffiller-dialog-body");

		const $preview = dialog.fields_dict.pdf_preview.$wrapper;
		$preview.html(render_preview_shell());
		const $viewer = $preview.find(".pdffiller-viewer").first();
		$viewer.find(".pdffiller-fields-only-checkbox").prop("checked", state.fields_only);
		$viewer
			.find(".pdffiller-form-wrapper")
			.toggleClass("pdffiller-form-wrapper--collapsed", !has_editable_fields(state.fields))
			.html(render_form_panel(state.fields));

		function reload() {
			if (typeof opts.load !== "function") {
				return;
			}
			state.overrides = collect_overrides($viewer, state.fields || []);
			const $frame = $viewer.find(".pdffiller-viewer-frame");
			$frame.html(`<div class="pdffiller-loading text-muted">${__("Generating PDF...")}</div>`);
			$viewer.find(".pdffiller-print-btn, .pdffiller-download-btn, .pdffiller-attach-btn, .pdffiller-email-btn").prop("disabled", true);
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
		const state = {
			fields: [],
			payload: null,
			fields_only: false,
			frm: frm,
			template_name: template_name,
			source: form_source,
		};
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
				show_warnings($viewer, r.message.warnings);
				$viewer
					.find(".pdffiller-fields-only-checkbox")
					.prop("checked", state.fields_only);
				const $form_wrapper = $viewer.find(".pdffiller-form-wrapper");
				$form_wrapper
					.toggleClass("pdffiller-form-wrapper--collapsed", !has_editable_fields(state.fields))
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
