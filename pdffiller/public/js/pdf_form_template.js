frappe.ui.form.on("PDF Form Template", {
	refresh(frm) {
		if (!frm.is_new()) {
			frm.add_custom_button(__("Scan PDF Fields"), function () {
				scan_pdf_fields(frm);
			});
		}
	},
});

function scan_pdf_fields(frm) {
	if (!frm.doc.pdf_file) {
		frappe.msgprint({
			title: __("PDF Required"),
			message: __("Attach a fillable PDF file before scanning fields."),
			indicator: "orange",
		});
		return;
	}

	frappe.call({
		method: "pdffiller.api.forms.list_pdf_fields",
		args: { template: frm.doc.name },
		freeze: true,
		callback(r) {
			const fields = r.message || [];
			if (!fields.length) {
				frappe.msgprint({
					title: __("No Fields Found"),
					message: __("No AcroForm fields were found in the attached PDF."),
					indicator: "orange",
				});
				return;
			}

			const existing = new Set(
				(frm.doc.field_mappings || []).map((row) => row.pdf_field_name).filter(Boolean)
			);
			let added = 0;

			fields.forEach(function (field_name) {
				if (existing.has(field_name)) return;
				const row = frm.add_child("field_mappings");
				row.pdf_field_name = field_name;
				row.source_type = "Field Path";
				added += 1;
			});

			frm.refresh_field("field_mappings");
			pdffiller.forms.clear_cache(frm.doc.reference_doctype);

			frappe.show_alert({
				message: added
					? __("Added {0} PDF field(s)", [added])
					: __("All PDF fields are already mapped"),
				indicator: added ? "green" : "blue",
			});
		},
	});
}
