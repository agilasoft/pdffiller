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

	function render_preview($wrapper, data_uri) {
		const html = `
			<div class="pdffiller-viewer">
				<div class="pdffiller-viewer-toolbar">
					<button type="button" class="btn btn-default btn-sm pdffiller-print-btn">
						${__("Print")}
					</button>
					<button type="button" class="btn btn-primary btn-sm pdffiller-download-btn">
						${__("Download")}
					</button>
				</div>
				<div class="pdffiller-viewer-frame">
					<object style="background:#323639;" width="100%" height="100%">
						<embed
							style="background:#323639;"
							width="100%"
							height="100%"
							src="${frappe.utils.escape_html(data_uri)}"
							type="application/pdf"
						/>
					</object>
				</div>
			</div>
		`;
		$wrapper.html(html);
		return $wrapper.find(".pdffiller-viewer").first();
	}

	pdffiller.viewer.open = function (frm, template_name, template_title) {
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

		dialog.show();
		dialog.$wrapper.find(".modal-body").addClass("pdffiller-dialog-body");

		const $preview = dialog.fields_dict.pdf_preview.$wrapper;
		$preview.html(`<p class="text-muted">${__("Generating PDF...")}</p>`);

		frappe.call({
			method: "pdffiller.api.forms.get_filled_pdf",
			args: {
				template: template_name,
				doctype: frm.doctype,
				name: frm.doc.name,
			},
			freeze: true,
			callback(r) {
				if (!r.message || !r.message.data_uri) {
					dialog.hide();
					frappe.msgprint({
						title: __("Error"),
						message: __("Could not generate the filled PDF."),
						indicator: "red",
					});
					return;
				}

				const payload = r.message;
				const $viewer = render_preview($preview, payload.data_uri);
				$viewer.find(".pdffiller-print-btn").on("click", function () {
					print_pdf(payload.data_uri);
				});
				$viewer.find(".pdffiller-download-btn").on("click", function () {
					download_pdf(payload.data_uri, payload.filename);
				});
			},
			error() {
				dialog.hide();
			},
		});
	};
})();
