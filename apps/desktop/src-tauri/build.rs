fn main() {
    // App commands are behind the ACL: the first-run page (static capability) and the hub's page
    // (runtime capability for its origin, see `hub::grant`) get their `allow-*` permissions.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "hub_url_get",
            "hub_url_set",
            "hub_change",
            "update_check",
            "update_install",
            "connector_status",
            "connector_link",
            "connector_unlink",
            "project_pick",
            "project_add",
            "project_remove",
        ]),
    ))
    .expect("failed to run tauri-build");
}
