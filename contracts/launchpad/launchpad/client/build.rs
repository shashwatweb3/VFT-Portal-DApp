use sails_client_gen::ClientGenerator;
use std::{env, path::PathBuf};

fn main() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let idl_path = out_dir.join("launchpad.idl");
    sails_idl_gen::generate_idl_to_file::<launchpad_app::LaunchpadProgram>(&idl_path).unwrap();
    ClientGenerator::from_idl_path(&idl_path)
        .generate_to(out_dir.join("launchpad_client.rs"))
        .unwrap();
}
