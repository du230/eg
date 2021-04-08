//Imports
  import core from "@actions/core"
  import github from "@actions/github"
  import octokit from "@octokit/graphql"
  import setup from "../metrics/setup.mjs"
  import mocks from "../mocks/index.mjs"
  import metrics from "../metrics/index.mjs"
  import fs from "fs/promises"
  import paths from "path"
  import sgit from "simple-git"
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

//Waiter
  async function wait(seconds) {
    await new Promise(solve => setTimeout(solve, seconds*1000))
  }

//Runner
  (async function() {
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
            if (/Auto-generated metrics for run #\d+/.test(github.context.payload.head_commit.message)) {
              console.log("Skipped because this seems to be an automated pull request merge")
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
            "committer.token":_token, "committer.branch":_branch, "committer.message":_message, "committer.gist":_gist,
            "use.prebuilt.image":_image,
            retries, "retries.delay":retries_delay,
            "output.action":_action,
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
          q["debug.flags"] = dflags.join(" ")

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
              committer.token = _token || token
              committer.gist = _action === "gist" ? _gist : null
              committer.commit = true
              committer.message = _message.replace(/[$][{]filename[}]/g, filename)
              committer.pr = /^pull-request/.test(_action)
              committer.merge = _action.match(/^pull-request-(?<method>merge|squash|rebase)$/)?.groups?.method ?? null
              committer.branch = _branch || github.context.ref.replace(/^refs[/]heads[/]/, "")
              committer.head = committer.pr ? `metrics-run-${github.context.runId}` : committer.branch
              info("Committer token", committer.token, {token:true})
              if (!committer.token)
                throw new Error("You must provide a valid GitHub token to commit your metrics")
              info("Committer branch", committer.branch)
              info("Committer head branch", committer.head)
            //Gist
              if (committer.gist)
                info("Committer Gist id", committer.gist)
            //Instantiate API for committer
              committer.rest = github.getOctokit(committer.token)
              info("Committer REST API", "ok")
              try {
                info("Committer account", (await committer.rest.users.getAuthenticated()).data.login)
              }
              catch {
                info("Committer account", "(github-actions)")
              }
            //Create head branch if needed
              try {
                await committer.rest.git.getRef({...github.context.repo, ref:`heads/${committer.head}`})
                info("Committer head branch status", "ok")
              }
              catch (error) {
                console.debug(error)
                if (/not found/i.test(`${error}`)) {
                  const {data:{object:{sha}}} = await committer.rest.git.getRef({...github.context.repo, ref:`heads/${committer.branch}`})
                  info("Committer branch current sha", sha)
                  await committer.rest.git.createRef({...github.context.repo, ref:`refs/heads/${committer.head}`, sha})
                  info("Committer head branch status", "(created)")
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
                        object(expression: "${committer.head}:${filename}") { ... on Blob { oid } }
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
          const convert = ["jpeg", "png", "json", "markdown"].includes(config["config.output"]) ? config["config.output"] : null
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
              await wait(retries_delay)
            }
          }
          if (!rendered)
            throw error ?? new Error("Could not render metrics")
          info("Status", "complete")

        //Save output to renders output folder
          info.break()
          info.section("Saving")
          if (dryrun)
            info("Actions to perform", "(none)")
          else {
            await fs.mkdir(paths.dirname(paths.join("/renders", filename)), {recursive:true})
            await fs.writeFile(paths.join("/renders", filename), Buffer.from(rendered))
            info(`Save to /metrics_renders/${filename}`, "ok")
          }

        //Check editions
          if ((committer.commit)||(committer.pr)) {
            const git = sgit()
            const sha = await git.hashObject(paths.join("/renders", filename))
            info("Current render sha", sha)
            if (committer.sha === sha) {
              info(`Commit to branch ${committer.branch}`, "(no changes)")
              committer.commit = false
            }
          }

        //Upload to gist (this is done as user since committer_token may not have gist rights)
          if (committer.gist) {
            await rest.gists.update({gist_id:committer.gist, files:{[filename]:{content:rendered}}})
            info(`Upload to gist ${committer.gist}`, "ok")
            committer.commit = false
          }

        //Commit metrics
          if (committer.commit) {
            await committer.rest.repos.createOrUpdateFileContents({
              ...github.context.repo, path:filename, message:committer.message,
              content:Buffer.from(rendered).toString("base64"),
              branch:committer.pr ? committer.head : committer.branch,
              ...(committer.sha ? {sha:committer.sha} : {}),
            })
            info(`Commit to branch ${committer.branch}`, "ok")
          }

        //Pull request
          if (committer.pr) {
            //Create pull request
              let number = null
              try {
                ({data:{number}} = await committer.rest.pulls.create({...github.context.repo, head:committer.head, base:committer.branch, title:`Auto-generated metrics for run #${github.context.runId}`, body:" ", maintainer_can_modify:true}))
                info(`Pull request from ${committer.head} to ${committer.branch}`, "(created)")
              }
              catch (error) {
                console.debug(error)
                if (/A pull request already exists/.test(error)) {
                  info(`Pull request from ${committer.head} to ${committer.branch}`, "(already existing)")
                  const q = `repo:${github.context.repo.owner}/${github.context.repo.repo}+type:pr+state:open+Auto-generated metrics for run #${github.context.runId}+in:title`
                  const prs = (await committer.rest.search.issuesAndPullRequests({q})).data.items.filter(({user:{login}}) => login === "github-actions[bot]")
                  if (prs.length < 1)
                    throw new Error("0 matching prs. Cannot proceed.")
                  if (prs.length > 1)
                    throw new Error(`Found more than one matching prs: ${prs.map(({number}) => `#${number}`).join(", ")}. Cannot proceed.`)
                  ;({number} = prs.shift())
                }
                else
                  throw error
              }
              info("Pull request number", number)
            //Merge pull request
              if (committer.merge) {
                info("Merge method", committer.merge)
                let attempts = 240
                do {
                  //Check pull request mergeability (https://octokit.github.io/rest.js/v18#pulls-get)
                    const {data:{mergeable, mergeable_state:state}} = await committer.rest.pulls.get({...github.context.repo, pull_number:number})
                    console.debug(`Pull request #${number} mergeable state is "${state}"`)
                    if (mergeable === null) {
                      await wait(15)
                      continue
                    }
                    if (!mergeable)
                      throw new Error(`Pull request #${number} is not mergeable (state is "${state}")`)
                  //Merge pull request
                    await committer.rest.pulls.merge({...github.context.repo, pull_number:number, merge_method:committer.merge})
                    info(`Merge #${number} to ${committer.branch}`, "ok")
                  //Delete head branch
                    try {
                      await wait(15)
                      await committer.rest.git.deleteRef({...github.context.repo, ref:`heads/${committer.head}`})
                    }
                    catch (error) {
                      console.debug(error)
                      if (!/reference does not exist/i.test(`${error}`))
                        throw error
                    }
                    info(`Branch ${committer.head}`, "(deleted)")
                    break
                } while (--attempts)
              }
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