frappe.pages["pdf-field-designer"].on_page_load = function (wrapper) {
	frappe.require("/assets/pdffiller/js/pdf_field_designer/designer.js", () => {
		pdffiller.designer.setup_page(wrapper);
	});
};

frappe.pages["pdf-field-designer"].on_page_show = function () {
	frappe.require("/assets/pdffiller/js/pdf_field_designer/designer.js", () => {
		pdffiller.designer.refresh();
	});
};
