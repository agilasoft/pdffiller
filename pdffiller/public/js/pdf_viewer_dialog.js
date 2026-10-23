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

	const PDFJS_ASSET_VERSION = "3.11.174";
	const PDF_REFRESH_DELAY = 400;
	let pdfjs_loader = null;

	function uses_live_widgets(state) {
		return (state.source || "form_template") !== "print_design";
	}

	function base_field_name(name) {
		return String(name || "").replace(/__p\d+$/, "");
	}

	function overrides_key(overrides) {
		const names = Object.keys(overrides || {}).sort();
		return JSON.stringify(
			names.map(function (name) {
				return [name, overrides[name]];
			})
		);
	}

	function find_editable_field(state, widget_name) {
		const base = base_field_name(widget_name);
		const fields = (state && state.fields) || [];
		for (let i = 0; i < fields.length; i += 1) {
			const field = fields[i];
			if (!field || !field.editable || field.field_type === "Signature") continue;
			if (field.pdf_field_name === base) return field;
		}
		return null;
	}

	function read_widget_value(el) {
		const type = (el.getAttribute("type") || "").toLowerCase();
		if (type === "radio") {
			if (!el.checked) return null;
			return el.value || "Yes";
		}
		if (type === "checkbox") {
			if (!el.checked) return "Off";
			const raw = el.value;
			if (!raw || raw.toLowerCase() === "on") return "Yes";
			return raw;
		}
		return el.value;
	}

	function load_asset_style(href) {
		return new Promise(function (resolve, reject) {
			const existing = document.querySelector(`link[data-pdffiller-href="${href}"]`);
			if (existing && existing.dataset.loaded === "1") {
				resolve();
				return;
			}
			if (existing) {
				existing.addEventListener("load", function () {
					resolve();
				});
				existing.addEventListener("error", function () {
					reject(new Error(href));
				});
				return;
			}
			const link = document.createElement("link");
			link.rel = "stylesheet";
			link.href = href;
			link.dataset.pdffillerHref = href;
			link.onload = function () {
				link.dataset.loaded = "1";
				resolve();
			};
			link.onerror = function () {
				reject(new Error(href));
			};
			document.head.appendChild(link);
		});
	}

	function load_asset_script(src) {
		return new Promise(function (resolve, reject) {
			const existing = document.querySelector(`script[data-pdffiller-src="${src}"]`);
			if (existing && existing.dataset.loaded === "1") {
				resolve();
				return;
			}
			if (existing) {
				existing.addEventListener("load", function () {
					resolve();
				});
				existing.addEventListener("error", function () {
					reject(new Error(src));
				});
				return;
			}
			const script = document.createElement("script");
			script.src = src;
			script.async = false;
			script.dataset.pdffillerSrc = src;
			script.onload = function () {
				script.dataset.loaded = "1";
				resolve();
			};
			script.onerror = function () {
				reject(new Error(src));
			};
			document.head.appendChild(script);
		});
	}

	function ensure_pdfjs() {
		if (window.pdfjsLib && window.pdfjsViewer) return Promise.resolve();
		if (pdfjs_loader) return pdfjs_loader;
		const version = PDFJS_ASSET_VERSION;
		pdfjs_loader = load_asset_style(`/assets/pdffiller/css/pdf_viewer.css?v=${version}`)
			.then(function () {
				return load_asset_script(`/assets/pdffiller/js/pdfjs/pdf.min.js?v=${version}`);
			})
			.then(function () {
				return load_asset_script(`/assets/pdffiller/js/pdfjs/pdf_viewer.js?v=${version}`);
			})
			.then(function () {
				if (!window.pdfjsLib || !window.pdfjsViewer) {
					throw new Error("PDF.js did not load");
				}
				window.pdfjsLib.GlobalWorkerOptions.workerSrc =
					`/assets/pdffiller/js/pdfjs/pdf.worker.min.js?v=${version}`;
			})
			.catch(function (error) {
				pdfjs_loader = null;
				throw error;
			});
		return pdfjs_loader;
	}

	function release_pdf_url(state) {
		if (!state || !state.pdf_object_url) return;
		URL.revokeObjectURL(state.pdf_object_url);
		state.pdf_object_url = null;
	}

	function destroy_pdf_document(state) {
		if (!state) return;
		const task = state.pdf_loading_task;
		const doc = state.pdf_document;
		state.pdf_loading_task = null;
		state.pdf_document = null;
		state.pdf_viewer = null;
		if (task) {
			try {
				task.destroy();
			} catch (error) {
				/* The task may already have finished. */
			}
		}
		if (doc) {
			try {
				doc.destroy();
			} catch (error) {
				/* The document may already have been destroyed. */
			}
		}
	}

	function pdf_widgets_focused(state) {
		const root = state && state.pdf_root;
		if (!root || !root.isConnected) return false;
		const active = document.activeElement;
		return Boolean(active && active !== root && root.contains(active));
	}

	function data_uri_bytes(data_uri) {
		const comma = String(data_uri || "").indexOf(",");
		if (comma < 0 || data_uri.indexOf("base64") < 0) return null;
		const binary = atob(data_uri.slice(comma + 1));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	}

	function pdf_blob_url(data_uri) {
		const bytes = data_uri_bytes(data_uri);
		if (!bytes) return null;
		const comma = String(data_uri || "").indexOf(",");
		const header = comma >= 0 ? data_uri.slice(0, comma) : "";
		const mime_match = /data:([^;,]+)/.exec(header);
		const mime = (mime_match && mime_match[1]) || "application/pdf";
		return URL.createObjectURL(new Blob([bytes], { type: mime }));
	}

	function render_pdf_frame($frame, data_uri, state) {
		const previous = state && state.pdf_object_url;
		let src = data_uri;
		if (state) {
			state.pdfjs_generation = (state.pdfjs_generation || 0) + 1;
			destroy_pdf_document(state);
			state.pdf_root = null;
			try {
				const url = pdf_blob_url(data_uri);
				state.pdf_object_url = url;
				if (url) src = url;
			} catch (error) {
				state.pdf_object_url = null;
			}
		}
		$frame.html(
			`<iframe class="pdffiller-pdf-frame" title="${frappe.utils.escape_html(
				__("PDF preview")
			)}" src="${frappe.utils.escape_html(src)}"></iframe>`
		);
		if (previous && previous !== (state && state.pdf_object_url)) {
			URL.revokeObjectURL(previous);
		}
	}

	function lock_locked_widgets(root, state) {
		if (!root) return;
		root.querySelectorAll("input, textarea, select").forEach(function (el) {
			if (find_editable_field(state, el.name)) return;
			el.disabled = true;
			el.readOnly = true;
		});
	}

	function mirror_field_value($viewer, field_name, value) {
		const input = $viewer.find(
			`.pdffiller-field-input[data-field-name="${CSS.escape(field_name)}"]`
		)[0];
		if (!input || input.type === "hidden") return;
		if (input.value === value) return;
		input.value = value;
	}

	function render_pdfjs($frame, data_uri, state, $viewer) {
		const bytes = data_uri_bytes(data_uri);
		if (!bytes) {
			render_pdf_frame($frame, data_uri, state);
			return Promise.resolve();
		}
		const generation = (state.pdfjs_generation || 0) + 1;
		state.pdfjs_generation = generation;
		if (state.pdf_root) state.pdf_scroll_top = state.pdf_root.scrollTop;
		destroy_pdf_document(state);
		release_pdf_url(state);

		$frame.html(
			`<div class="pdffiller-pdfjs">
				<div class="pdffiller-pdfjs-toolbar">
					<button type="button" class="btn btn-default btn-xs" data-pdffiller-zoom="out" title="${frappe.utils.escape_html(
						__("Zoom out")
					)}">−</button>
					<button type="button" class="btn btn-default btn-xs" data-pdffiller-zoom="fit">${__(
						"Fit width"
					)}</button>
					<button type="button" class="btn btn-default btn-xs" data-pdffiller-zoom="in" title="${frappe.utils.escape_html(
						__("Zoom in")
					)}">+</button>
				</div>
				<div class="pdffiller-pdfjs-scroll">
					<div class="pdfViewer"></div>
				</div>
			</div>`
		);
		const scroll_el = $frame.find(".pdffiller-pdfjs-scroll")[0];
		const viewer_el = scroll_el.firstElementChild;
		state.pdf_root = scroll_el;

		let pdf_viewer;
		try {
			const event_bus = new window.pdfjsViewer.EventBus();
			const link_service = new window.pdfjsViewer.PDFLinkService({ eventBus: event_bus });
			pdf_viewer = new window.pdfjsViewer.PDFViewer({
				container: scroll_el,
				viewer: viewer_el,
				eventBus: event_bus,
				linkService: link_service,
				textLayerMode: 0,
				annotationMode: window.pdfjsLib.AnnotationMode.ENABLE_FORMS,
			});
			link_service.setViewer(pdf_viewer);
			state.pdf_viewer = pdf_viewer;
			state.pdf_link_service = link_service;
			event_bus.on("pagesinit", function () {
				if (state.pdfjs_generation !== generation) return;
				pdf_viewer.currentScaleValue = state.pdf_scale || "page-width";
				if (state.pdf_scroll_top) scroll_el.scrollTop = state.pdf_scroll_top;
			});
			event_bus.on("scalechanging", function (evt) {
				if (!evt) return;
				state.pdf_scale = evt.presetValue || String(evt.scale);
			});
			event_bus.on("annotationlayerrendered", function () {
				if (state.pdfjs_generation !== generation) return;
				lock_locked_widgets(scroll_el, state);
			});
		} catch (error) {
			render_pdf_frame($frame, data_uri, state);
			return Promise.resolve();
		}

		function on_widget_edit(event) {
			const el = event.target;
			if (!el || !el.name) return;
			const tag = el.tagName;
			if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;
			if (el.disabled) return;
			const field = find_editable_field(state, el.name);
			if (!field) return;
			const value = read_widget_value(el);
			if (value === null) return;
			mirror_field_value($viewer, field.pdf_field_name, value);
			schedule_refresh($viewer, state);
		}

		scroll_el.addEventListener("input", on_widget_edit);
		scroll_el.addEventListener("change", on_widget_edit);
		scroll_el.addEventListener(
			"focusin",
			function (event) {
				lock_locked_widgets(scroll_el, state);
				if (event.target && event.target.disabled && event.target.blur) event.target.blur();
			},
			true
		);
		scroll_el.addEventListener("focusout", function () {
			setTimeout(function () {
				if (state.pdfjs_generation !== generation) return;
				if (pdf_widgets_focused(state)) return;
				settle_preview($viewer, state);
			}, 0);
		});
		scroll_el.addEventListener("scroll", function () {
			if (state.pdf_root === scroll_el) state.pdf_scroll_top = scroll_el.scrollTop;
		});
		$frame.find("[data-pdffiller-zoom]").on("click", function () {
			const viewer = state.pdf_viewer;
			if (!viewer || state.pdfjs_generation !== generation) return;
			const action = this.getAttribute("data-pdffiller-zoom");
			if (action === "in") viewer.currentScale = Math.min(viewer.currentScale * 1.15, 4);
			else if (action === "out") viewer.currentScale = Math.max(viewer.currentScale / 1.15, 0.25);
			else viewer.currentScaleValue = "page-width";
		});

		const task = window.pdfjsLib.getDocument({ data: bytes });
		state.pdf_loading_task = task;
		return task.promise
			.then(function (pdf) {
				if (state.pdfjs_generation !== generation) {
					pdf.destroy();
					return;
				}
				state.pdf_document = pdf;
				state.pdf_link_service.setDocument(pdf, null);
				state.pdf_viewer.setDocument(pdf);
			})
			.catch(function () {
				if (state.pdfjs_generation !== generation) return;
				render_pdf_frame($frame, data_uri, state);
			});
	}

	function render_preview($frame, data_uri, state, $viewer) {
		if (state && state.closed) return Promise.resolve();
		if (!uses_live_widgets(state)) {
			render_pdf_frame($frame, data_uri, state);
			return Promise.resolve();
		}
		return ensure_pdfjs()
			.then(function () {
				if (state.closed) return;
				return render_pdfjs($frame, data_uri, state, $viewer);
			})
			.catch(function () {
				if (state.closed) return;
				if (!state.pdfjs_failed_notice) {
					state.pdfjs_failed_notice = true;
					frappe.show_alert({
						message: __("Preview fields could not be loaded. Use Field Values to edit this PDF."),
						indicator: "orange",
					});
				}
				render_pdf_frame($frame, data_uri, state);
			});
	}

	function bind_pdf_url_cleanup(dialog, state) {
		dialog.$wrapper.on("hidden.bs.modal", function () {
			state.closed = true;
			if (state.refresh_timer) {
				clearTimeout(state.refresh_timer);
				state.refresh_timer = null;
			}
			state.pdfjs_generation = (state.pdfjs_generation || 0) + 1;
			destroy_pdf_document(state);
			release_pdf_url(state);
		});
	}

	function sync_form_panel($viewer, state, fields) {
		const was_editable = has_editable_fields(state.fields);
		state.fields = fields || [];
		const $wrapper = $viewer.find(".pdffiller-form-wrapper");
		const user_collapsed = $wrapper.hasClass("pdffiller-form-wrapper--collapsed");
		$wrapper.html(render_form_panel(state.fields));
		const now_editable = has_editable_fields(state.fields);
		// The shell starts collapsed. Open it once editable values arrive, and
		// leave a column the user closed that way until the editable set changes.
		if (now_editable && !was_editable) {
			$wrapper.removeClass("pdffiller-form-wrapper--collapsed");
		} else if (user_collapsed) {
			$wrapper.addClass("pdffiller-form-wrapper--collapsed");
		} else {
			$wrapper.removeClass("pdffiller-form-wrapper--collapsed");
		}
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

	function action_buttons($viewer) {
		return $viewer.find(
			".pdffiller-print-btn, .pdffiller-download-btn, .pdffiller-attach-btn, .pdffiller-email-btn"
		);
	}

	function request_filled_pdf(state, overrides, options) {
		options = options || {};
		return new Promise(function (resolve) {
			if (state.closed) {
				resolve({ payload: null, failed: true });
				return;
			}
			if (typeof state.load === "function") {
				state.overrides = overrides;
				let settled = false;
				const finish = function (payload) {
					if (settled) return;
					settled = true;
					resolve({ payload: payload || null, failed: false });
				};
				try {
					state.load(state, finish);
				} catch (error) {
					finish(null);
				}
				return;
			}
			if (!state.frm || !state.template_name) {
				resolve({ payload: null, failed: true });
				return;
			}
			frappe.call({
				method: "pdffiller.api.forms.get_filled_pdf",
				args: {
					template: state.template_name,
					doctype: state.frm.doctype,
					name: state.frm.doc.name,
					field_overrides: overrides,
					fields_only: state.fields_only ? 1 : 0,
					source: state.source || "form_template",
				},
				freeze: Boolean(options.freeze),
				callback(response) {
					resolve({ payload: (response && response.message) || null, failed: false });
				},
				error() {
					resolve({ payload: null, failed: true });
				},
			});
		});
	}

	function refresh_payload($viewer, state, options) {
		options = options || {};
		if (state.closed) return Promise.resolve(null);
		const overrides = collect_overrides($viewer, state.fields || []);
		const key = overrides_key(overrides);
		const id = (state.refresh_seq = (state.refresh_seq || 0) + 1);
		state.refresh_key = key;
		const $frame = $viewer.find(".pdffiller-viewer-frame");
		if (options.placeholder) {
			state.explicit_refresh = true;
			if (state.refresh_timer) {
				clearTimeout(state.refresh_timer);
				state.refresh_timer = null;
			}
			if (state.pdf_root) state.pdf_scroll_top = state.pdf_root.scrollTop;
			state.pdfjs_generation = (state.pdfjs_generation || 0) + 1;
			destroy_pdf_document(state);
			state.pdf_root = null;
			$frame.html(`<div class="pdffiller-loading text-muted">${__("Generating PDF...")}</div>`);
			action_buttons($viewer).prop("disabled", true);
		}
		const promise = request_filled_pdf(state, overrides, options)
			.then(function (result) {
				if (state.closed || state.refresh_seq !== id) return null;
				const payload = result && result.payload;
				if (!payload || !payload.data_uri) {
					if (!result || !result.failed) {
						frappe.msgprint({
							title: __("Error"),
							message: __("Could not generate the filled PDF."),
							indicator: "red",
						});
					}
					if (options.placeholder) {
						$frame.html(
							`<div class="pdffiller-loading text-muted">${__(
								"Could not generate the filled PDF."
							)}</div>`
						);
						if (state.payload && state.payload.data_uri) action_buttons($viewer).prop("disabled", false);
					}
					return null;
				}
				state.saved_key = key;
				const focused = pdf_widgets_focused(state);
				const stale =
					overrides_key(collect_overrides($viewer, state.fields || [])) !== key;
				const render_now =
					Boolean(options.placeholder) || !uses_live_widgets(state) || (!focused && !stale);
				state.pending_rerender = !render_now;
				return apply_payload($viewer, state, payload, { skip_render: !render_now }).then(function () {
					return state.payload;
				});
			})
			.finally(function () {
				if (state.refresh_promise === promise) {
					state.refresh_promise = null;
					state.explicit_refresh = false;
				}
			});
		state.refresh_promise = promise;
		return promise;
	}

	function schedule_refresh($viewer, state) {
		if (!uses_live_widgets(state) || state.closed || state.explicit_refresh) return;
		if (state.refresh_timer) clearTimeout(state.refresh_timer);
		state.refresh_timer = setTimeout(function () {
			state.refresh_timer = null;
			refresh_payload($viewer, state, {});
		}, PDF_REFRESH_DELAY);
	}

	function settle_preview($viewer, state, attempt) {
		attempt = attempt || 0;
		if (state.closed || !uses_live_widgets(state) || pdf_widgets_focused(state)) {
			return Promise.resolve();
		}
		if (attempt > 3) {
			state.pending_rerender = false;
			if (state.payload && state.payload.data_uri) {
				return render_preview(
					$viewer.find(".pdffiller-viewer-frame"),
					state.payload.data_uri,
					state,
					$viewer
				);
			}
			return Promise.resolve();
		}
		if (state.refresh_timer) {
			clearTimeout(state.refresh_timer);
			state.refresh_timer = null;
			return refresh_payload($viewer, state, {}).then(function () {
				return settle_preview($viewer, state, attempt + 1);
			});
		}
		if (state.refresh_promise) {
			return state.refresh_promise.then(function () {
				return settle_preview($viewer, state, attempt + 1);
			});
		}
		const key = overrides_key(collect_overrides($viewer, state.fields || []));
		if (state.saved_key !== key) {
			return refresh_payload($viewer, state, {}).then(function () {
				return settle_preview($viewer, state, attempt + 1);
			});
		}
		if (state.pending_rerender && state.payload && state.payload.data_uri) {
			state.pending_rerender = false;
			return render_preview(
				$viewer.find(".pdffiller-viewer-frame"),
				state.payload.data_uri,
				state,
				$viewer
			);
		}
		return Promise.resolve();
	}

	function ensure_fresh_pdf($viewer, state, attempt) {
		attempt = attempt || 0;
		if (state.closed) return Promise.resolve(null);
		if (!uses_live_widgets(state)) return Promise.resolve(state.payload);
		if (state.refresh_timer) {
			clearTimeout(state.refresh_timer);
			state.refresh_timer = null;
		}
		const key = overrides_key(collect_overrides($viewer, state.fields || []));
		if (
			state.payload &&
			state.payload.data_uri &&
			state.saved_key === key &&
			!state.refresh_promise
		) {
			return Promise.resolve(state.payload);
		}
		if (attempt > 3) return Promise.resolve(null);
		const after = function (payload) {
			if (!payload) return null;
			return ensure_fresh_pdf($viewer, state, attempt + 1);
		};
		if (state.refresh_promise) return state.refresh_promise.then(after);
		return refresh_payload($viewer, state, {}).then(after);
	}

	function with_fresh_pdf($viewer, state, action) {
		const $buttons = action_buttons($viewer);
		state.action_depth = (state.action_depth || 0) + 1;
		$buttons.prop("disabled", true);
		return ensure_fresh_pdf($viewer, state)
			.then(function (payload) {
				state.action_depth -= 1;
				if (!state.action_depth) {
					$buttons.prop("disabled", !(state.payload && state.payload.data_uri));
				}
				if (!payload || !payload.data_uri) return;
				action(payload);
			})
			.catch(function () {
				state.action_depth = Math.max(0, (state.action_depth || 1) - 1);
				if (!state.action_depth) {
					$buttons.prop("disabled", !(state.payload && state.payload.data_uri));
				}
			});
	}

	function regenerate($viewer, state) {
		if (state.refresh_timer) {
			clearTimeout(state.refresh_timer);
			state.refresh_timer = null;
		}
		return refresh_payload($viewer, state, { placeholder: true, freeze: true });
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
			with_fresh_pdf($viewer, state, function (payload) {
				print_pdf(payload.data_uri);
			});
		});

		$viewer.find(".pdffiller-download-btn").off("click").on("click", function () {
			with_fresh_pdf($viewer, state, function (payload) {
				download_pdf(payload.data_uri, payload.filename);
			});
		});

		$viewer.find(".pdffiller-attach-btn").off("click").on("click", function () {
			with_fresh_pdf($viewer, state, function () {
				save_attachment($viewer, state, "attach");
			});
		});

		$viewer.find(".pdffiller-email-btn").off("click").on("click", function () {
			with_fresh_pdf($viewer, state, function () {
				save_attachment($viewer, state, "email");
			});
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

	function apply_payload($viewer, state, payload, options) {
		options = options || {};
		if (state.closed) return Promise.resolve();
		if (payload.fields) {
			sync_form_panel($viewer, state, payload.fields);
		}
		if (payload.fields_only !== undefined) {
			state.fields_only = Boolean(payload.fields_only);
			$viewer.find(".pdffiller-fields-only-checkbox").prop("checked", state.fields_only);
		}
		state.payload = payload;
		show_warnings($viewer, payload.warnings);
		if (!state.action_depth) action_buttons($viewer).prop("disabled", false);
		if (typeof state.reload === "function") {
			bind_preview_actions($viewer, state, state.reload);
		} else {
			bind_signature_pads($viewer);
		}
		if (options.skip_render) return Promise.resolve();
		return render_preview($viewer.find(".pdffiller-viewer-frame"), payload.data_uri, state, $viewer);
	}

	function bind_viewer_actions($viewer, state) {
		state.reload = function () {
			regenerate($viewer, state);
		};
		bind_preview_actions($viewer, state, state.reload);
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
			load: typeof opts.load === "function" ? opts.load : null,
		};
		dialog.show();
		dialog.$wrapper.find(".modal-body").addClass("pdffiller-dialog-body");
		bind_pdf_url_cleanup(dialog, state);
		if (uses_live_widgets(state)) ensure_pdfjs();

		const $preview = dialog.fields_dict.pdf_preview.$wrapper;
		$preview.html(render_preview_shell());
		const $viewer = $preview.find(".pdffiller-viewer").first();
		$viewer.find(".pdffiller-fields-only-checkbox").prop("checked", state.fields_only);
		$viewer
			.find(".pdffiller-form-wrapper")
			.toggleClass("pdffiller-form-wrapper--collapsed", !has_editable_fields(state.fields))
			.html(render_form_panel(state.fields));

		function reload() {
			if (typeof opts.load !== "function") return;
			regenerate($viewer, state);
		}

		state.reload = reload;
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
		bind_pdf_url_cleanup(dialog, state);
		if (uses_live_widgets(state)) ensure_pdfjs();

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
				bind_viewer_actions($viewer, state);
				regenerate($viewer, state);
			},
			error() {
				dialog.hide();
			},
		});
	};
})();
