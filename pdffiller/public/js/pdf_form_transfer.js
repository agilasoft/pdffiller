// Copyright (c) 2026, Agilasoft Cloud Technologies Inc. and contributors
// For license information, please see license.txt

frappe.provide("pdffiller.transfer");

pdffiller.transfer.export_templates = function (names) {
	const args = {};
	if (names && names.length) {
		args.templates = JSON.stringify(names);
	}
	open_url_post("/api/method/pdffiller.api.transfer.export_templates", args);
};

pdffiller.transfer.show_import_summary = function (summary) {
	summary = summary || {};
	const lines = [
		__("Created: {0}", [summary.created || 0]),
		__("Updated: {0}", [summary.updated || 0]),
		__("Errors: {0}", [summary.errors || 0]),
	];

	const details = [];
	(summary.results || []).forEach(function (row) {
		const title = row.title || __("(untitled)");
		if (row.status === "error") {
			details.push(
				`<li><b>${frappe.utils.escape_html(title)}</b>: ${frappe.utils.escape_html(
					row.message || ""
				)}</li>`
			);
		} else if (row.warnings && row.warnings.length) {
			details.push(
				`<li><b>${frappe.utils.escape_html(title)}</b>: ${frappe.utils.escape_html(
					row.warnings.join("; ")
				)}</li>`
			);
		}
	});

	let message = lines.join("<br>");
	if (details.length) {
		message += "<br><br>" + __("Notes") + ":<ul>" + details.join("") + "</ul>";
	}
	message +=
		"<br><br>" +
		__(
			"Reference DocTypes must exist on this site. Field paths and Jinja may need adjustments if the schema differs. Image mappings that pointed at site File URLs will not resolve until those files exist here."
		);

	frappe.msgprint({
		title: __("Import Complete"),
		indicator: summary.errors ? "orange" : "green",
		message: message,
	});
};

pdffiller.transfer.import_templates = function (on_done) {
	const dialog = new frappe.ui.Dialog({
		title: __("Import PDF Form Templates"),
		fields: [
			{
				fieldtype: "Attach",
				fieldname: "zip_file",
				label: __("ZIP Pack"),
				reqd: 1,
				description: __("Select a .zip file exported from another site."),
			},
		],
		primary_action_label: __("Import"),
		primary_action(values) {
			if (!values.zip_file) {
				frappe.msgprint(__("Please attach a ZIP file."));
				return;
			}
			dialog.hide();
			frappe.call({
				method: "pdffiller.api.transfer.import_templates",
				args: { file_url: values.zip_file },
				freeze: true,
				freeze_message: __("Importing templates..."),
				callback(r) {
					pdffiller.transfer.show_import_summary(r.message || {});
					if (typeof on_done === "function") {
						on_done(r.message);
					}
				},
			});
		},
	});
	dialog.show();
};
