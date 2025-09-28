def auto_venv [] {
    if (".venv/bin/activate" | path exists) {
        let current_venv = ($env.PWD | path join ".venv")
        if ($env.VIRTUAL_ENV? | is-empty) or ($env.VIRTUAL_ENV != $current_venv) {
            $env.VIRTUAL_ENV = $current_venv
            $env.PATH = ($env.PATH | prepend ($current_venv | path join "bin"))
            print $"Activated virtual environment: ($current_venv)"
        }
    } else if ($env.VIRTUAL_ENV? | is-not-empty) {
        $env.PATH = ($env.PATH | skip while {|x| $x != ($env.VIRTUAL_ENV | path join "bin")})
        $env.VIRTUAL_ENV = null
        print "Deactivated virtual environment."
    }
}

# Set up directory change hook
$env.config = ($env.config | merge {
    hooks: {
        env_change: {
            PWD: [{|before, after| auto_venv }]
        }
    }
})

# Run on initial load
auto_venv