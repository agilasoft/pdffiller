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

pdffiller.transfer._read_file_as_data_url = function (file) {
	return new Promise(function (resolve, reject) {
		const reader = new FileReader();
		reader.onload = function () {
			resolve(reader.result);
		};
		reader.onerror = function () {
			reject(reader.error || new Error("Failed to read file"));
		};
		reader.readAsDataURL(file);
	});
};

pdffiller.transfer._is_supported_pack = function (filename) {
	const name = (filename || "").toLowerCase();
	return name.endsWith(".txt") || name.endsWith(".json") || name.endsWith(".zip");
};

pdffiller.transfer.import_templates = function (on_done) {
	const dialog = new frappe.ui.Dialog({
		title: __("Import PDF Form Templates"),
		fields: [
			{
				fieldtype: "HTML",
				fieldname: "file_picker",
				options: `
					<div class="pdffiller-import-picker">
						<p class="text-muted small">
							${__(
								"Select the .txt pack exported from another site (legacy .json / .zip also work)."
							)}
						</p>
						<input type="file" class="form-control" accept=".txt,.json,.zip,text/plain,application/json" />
					</div>
				`,
			},
		],
		primary_action_label: __("Import"),
		async primary_action() {
			const input = dialog.$wrapper.find("input[type=file]")[0];
			const file = input && input.files && input.files[0];
			if (!file) {
				frappe.msgprint(__("Please select a pack file."));
				return;
			}

			if (!pdffiller.transfer._is_supported_pack(file.name)) {
				frappe.msgprint(__("Please select a .txt pack file (or legacy .json / .zip)."));
				return;
			}

			dialog.hide();
			frappe.dom.freeze(__("Importing templates..."));
			try {
				const data_url = await pdffiller.transfer._read_file_as_data_url(file);
				const r = await frappe.call({
					method: "pdffiller.api.transfer.import_templates",
					args: { file_content: data_url },
				});
				pdffiller.transfer.show_import_summary(r.message || {});
				if (typeof on_done === "function") {
					on_done(r.message);
				}
			} catch (err) {
				frappe.msgprint({
					title: __("Import Failed"),
					indicator: "red",
					message: (err && err.message) || __("Could not import the pack file."),
				});
			} finally {
				frappe.dom.unfreeze();
			}
		},
	});
	dialog.show();
};
