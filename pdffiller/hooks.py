app_name = "pdffiller"
app_title = "PDF Filler"
app_publisher = "Agilasoft Cloud Technologies Inc."
app_description = "Fillable PDF forms linked to DocTypes"
app_email = "info@agilasoft.com"
app_license = "agpl-3.0"

app_include_js = [
	"/assets/pdffiller/js/pdf_viewer_dialog.js",
	"/assets/pdffiller/js/pdf_form_buttons.js",
	"/assets/pdffiller/js/pdf_form_transfer.js",
	"/assets/pdffiller/js/workdesk_layout.js?v=20261021b",
	"/assets/pdffiller/js/designer_multi_select.js",
]
app_include_css = [
	"/assets/pdffiller/css/pdf_viewer_dialog.css",
	"/assets/pdffiller/css/workdesk_layout.css",
]

fixtures = [
	{"dt": "Workspace", "filters": [["module", "=", "PDF Filler"]]},
	{"dt": "Page", "filters": [["name", "in", ["pdf-field-designer", "pdf-print-designer"]]]},
	{"dt": "Desktop Icon", "filters": [["app", "=", "pdffiller"]]},
	{"dt": "Workspace Sidebar", "filters": [["app", "=", "pdffiller"]]},
]

doctype_js = {
	"PDF Form Template": "public/js/pdf_form_template.js",
	"PDF Print Design": "public/js/pdf_print_design.js",
}
doctype_list_js = {
	"PDF Form Template": "public/js/pdf_form_template_list.js",
	"PDF Print Design": "public/js/pdf_print_design_list.js",
}

extend_bootinfo = "pdffiller.boot.extend_bootinfo"
after_install = "pdffiller.install.after_install"
