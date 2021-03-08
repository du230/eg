//Imports
  import core from "@actions/core"
  import github from "@actions/github"
  import octokit from "@octokit/graphql"
  import setup from "../metrics/setup.mjs"
  import mocks from "../mocks/index.mjs"
  import metrics from "../metrics/index.mjs"
  import fs from "fs/promises"
  import paths from "path"
  process.on("unhandledRejection", error => { throw error }) //eslint-disable-line max-statements-per-line, brace-style

//Debug message buffer
  let DEBUG = true
  const debugged = []

//Info logger
  const info = (left, right, {token = false} = {}) =>  console.log(`${`${left}`.padEnd(56 + 9*(/0m$/.test(left)))} │ ${
    Array.isArray(right) ? right.join(", ") || "(none)" :
    right === undefined ? "(default)" :
    token ? /^MOCKED/.test(right) ? "(MOCKED TOKEN)" : /^NOT_NEEDED$/.test(right) ? "(NOT NEEDED)" : (right ? "(provided)" : "(missing)") :
    typeof right === "object" ? JSON.stringify(right) :
    right
  }`)
  info.section = (left = "", right = " ") => info(`\x1b[36m${left}\x1b[0m`, right)
  info.group = ({metadata, name, inputs}) => {
    info.section(metadata.plugins[name]?.name?.match(/(?<section>[\w\s]+)/i)?.groups?.section?.trim(), " ")
    for (const [input, value] of Object.entries(inputs))
      info(metadata.plugins[name]?.inputs[input]?.description ?? input, value, {token:metadata.plugins[name]?.inputs[input]?.type === "token"})
  }
  info.break = () => console.log("─".repeat(88))

//Runner
  ;(async function() {
      try {
        //Initialization
          info.break()
          info.section("Metrics")

        //Skip process if needed
          if ((github.context.eventName === "push")&&(github.context.payload?.head_commit)) {
            if (/\[Skip GitHub Action\]/.test(github.context.payload.head_commit.message)) {
              console.log("Skipped because [Skip GitHub Action] is in commit message")
              process.exit(0)
            }
          }

        //Load configuration
          const {conf, Plugins, Templates} = await setup({log:false, nosettings:true, community:{templates:core.getInput("setup_community_templates")}})
          const {metadata} = conf
          info("Setup", "complete")
          info("Version", conf.package.version)

        //Core inputs
          const {
            user:_user, repo:_repo, token,
            template, query, "setup.community.templates":_templates,
            filename, optimize, verify,
            debug, "debug.flags":dflags, "use.mocked.data":mocked, dryrun,
            "plugins.errors.fatal":die,
            "committer.token":_token, "committer.branch":_branch,
            "use.prebuilt.image":_image,
            retries, "retries.delay":retries_delay,
            ...config
          } = metadata.plugins.core.inputs.action({core})
          const q = {...query, ...(_repo ? {repo:_repo} : null), template}

        //Docker image
          if (_image)
            info("Using prebuilt image", _image)

        //Debug mode and flags
          info("Debug mode", debug)
          if (!debug) {
            console.debug = message => debugged.push(message)
            DEBUG = false
          }
          info("Debug flags", dflags)

        //Token for data gathering
          info("GitHub token", token, {token:true})
          if (!token)
            throw new Error('You must provide a valid GitHub personal token to gather your metrics (see "How to setup?" section at https://github.com/lowlighter/metrics#%EF%B8%8F-using-github-action-on-your-profile-repository-5-min-setup)')
          conf.settings.token = token
          const api = {}
          api.graphql = octokit.graphql.defaults({headers:{authorization:`token ${token}`}})
          info("Github GraphQL API", "ok")
          api.rest = github.getOctokit(token)
          info("Github REST API", "ok")
        //Apply mocking if needed
          if (mocked) {
            Object.assign(api, await mocks(api))
            info("Use mocked API", true)
          }
        //Extract octokits
          const {graphql, rest} = api

        //GitHub user
          let authenticated
          try {
            authenticated = (await rest.users.getAuthenticated()).data.login
          }
          catch {
            authenticated = github.context.repo.owner
          }
          const user = _user || authenticated
          info("GitHub account", user)
          if (q.repo)
            info("GitHub repository", `${user}/${q.repo}`)

        //Current repository
          info("Current repository", `${github.context.repo.owner}/${github.context.repo.repo}`)

        //Committer
          const committer = {}
          if (!dryrun) {
            //Compute committer informations
              committer.commit = true
              committer.token = _token || token
              committer.base = github.context.ref.replace(/^refs[/]heads[/]/, "")
              committer.branch = _branch || committer.base
              committer.pr = true
              committer.merge = true
              info("Committer token", committer.token, {token:true})
              if (!committer.token)
                throw new Error("You must provide a valid GitHub token to commit your metrics")
              info("Committer base branch", committer.base)
              info("Committer branch", committer.branch)
            //Instantiate API for committer
              committer.rest = github.getOctokit(committer.token)
              info("Committer REST API", "ok")
              try {
                info("Committer account", (await committer.rest.users.getAuthenticated()).data.login)
              }
              catch {
                info("Committer account", "(github-actions)")
              }
            //Create branch if needed
              try {
                await committer.rest.git.getRef({...github.context.repo, ref:`heads/${committer.branch}`})
                info("Committer branch status", "ok")
              }
              catch (error) {
                console.debug(error)
                if (/not found/i.test(`${error}`)) {
                  const {object:{sha}} = committer.rest.git.getRef({...github.context.repo, ref:`refs/heads/${committer.base}`})
                  info("Committer base branch sha", sha)
                  await committer.rest.git.createRef({...github.context.repo, ref:`refs/heads/${committer.branch}`, sha})
                  info("Committer branch status", "(created)")
                }
                else
                  throw error
              }
            //Retrieve previous render SHA to be able to update file content through API
              committer.sha = null
              try {
                const {repository:{object:{oid}}} = await graphql(`
                    query Sha {
                      repository(owner: "${github.context.repo.owner}", name: "${github.context.repo.repo}") {
                        object(expression: "${committer.branch}:${filename}") { ... on Blob { oid } }
                      }
                    }
                  `, {headers:{authorization:`token ${committer.token}`}})
                committer.sha = oid
              }
              catch (error) {
                console.debug(error)
              }
              info("Previous render sha", committer.sha ?? "(none)")
          }
          else
            info("Dry-run", true)

        //SVG file
          conf.settings.optimize = optimize
          info("SVG output", filename)
          info("SVG optimization", optimize)
          info("SVG verification after generation", verify)

        //Template
          info.break()
          info.section("Templates")
          info("Community templates", _templates)
          info("Template used", template)
          info("Query additional params", query)

        //Core config
          info.break()
          info.group({metadata, name:"core", inputs:config})
          info("Plugin errors", die ? "(exit with error)" : "(displayed in generated image)")
          const convert = ["jpeg", "png"].includes(config["config.output"]) ? config["config.output"] : null
          Object.assign(q, config)

        //Base content
          info.break()
          const {base:parts, ...base} = metadata.plugins.base.inputs.action({core})
          info.group({metadata, name:"base", inputs:base})
          info("Base sections", parts)
          base.base = false
          for (const part of conf.settings.plugins.base.parts)
            base[`base.${part}`] = parts.includes(part)
          Object.assign(q, base)

        //Additional plugins
          const plugins = {}
          for (const name of Object.keys(Plugins).filter(key => !["base", "core"].includes(key))) {
            //Parse inputs
              const {[name]:enabled, ...inputs} = metadata.plugins[name].inputs.action({core})
              plugins[name] = {enabled}
            //Register user inputs
              if (enabled) {
                info.break()
                info.group({metadata, name, inputs})
                q[name] = true
                for (const [key, value] of Object.entries(inputs)) {
                  //Store token in plugin configuration
                    if (metadata.plugins[name].inputs[key].type === "token")
                      plugins[name][key] = value
                  //Store value in query
                    else
                      q[`${name}.${key}`] = value
                }
              }
          }

        //Render metrics
          info.break()
          info.section("Rendering")
          let error = null, rendered = null
          for (let attempt = 1; attempt <= retries; attempt++) {
            try {
              console.debug(`::group::Attempt ${attempt}/${retries}`)
              ;({rendered} = await metrics({login:user, q}, {graphql, rest, plugins, conf, die, verify, convert}, {Plugins, Templates}))
              console.debug("::endgroup::")
              break
            }
            catch (_error) {
              error = _error
              console.debug("::endgroup::")
              console.debug(`::warning::rendering failed (${error.message})`)
              await new Promise(solve => setTimeout(solve, retries_delay*1000)) //eslint-disable-line no-promise-executor-return
            }
          }
          if (!rendered)
            throw error ?? new Error("Could not render metrics")
          info("Status", "complete")

        //Save output to renders output folder
          await fs.writeFile(paths.join("/renders", filename), Buffer.from(rendered))
          info(`Save to /metrics_renders/${filename}`, "ok")

        //Commit metrics
          if (committer.commit) {
            await committer.rest.repos.createOrUpdateFileContents({
              ...github.context.repo, path:filename, message:`Update ${filename} - [Skip GitHub Action]`,
              content:Buffer.from(rendered).toString("base64"),
              branch:committer.branch,
              ...(committer.sha ? {sha:committer.sha} : {}),
            })
            info(`Commit to ${ref}`, "ok")
          }

        //Create pull request
          if (committer.pr) {
            const z = await committer.rest.pulls.create({...github.context.repo, head:ref, base, body:`Auto-generated metrics for run #${github.payload.runId}`, maintainer_can_modify:true})
            info(`Pull request from ${committer.branch} to ${committer.base}`, "ok")
            console.log(z)
          }

        //Merge pull request
          if (committer.merge) {
            //await committer.rest.pulls.merge({...github.context.repo, pull_number:""})
            info(`Merge #${NaN} to ${committer.base}`, "ok")
          }
      
        //Success
          info.break()
          console.log("Success, thanks for using metrics!")
          process.exit(0)
      }
    //Errors
      catch (error) {
        console.error(error)
        //Print debug buffer if debug was not enabled (if it is, it's already logged on the fly)
          if (!DEBUG) {
            for (const log of [info.break(), "An error occured, logging debug message :", ...debugged])
              console.log(log)
          }
        core.setFailed(error.message)
        process.exit(1)
      }
  })()