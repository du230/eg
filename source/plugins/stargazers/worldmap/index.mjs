//Imports
import * as d3 from "d3"
import D3Node from "d3-node"
import color from "color"
import {Client as Gmap} from "@googlemaps/google-maps-services-js"

/**Worldmap */
export default async function (login, {locations, imports, token}) {
  //Parse geocodes
  let stars = new Map()
  if (token) {
    const cache = new Map()
    const get = new Gmap()
    for (const location of locations.filter(string => string).map(string => string.toLocaleLowerCase())) {
      console.debug(`metrics/compute/${login}/plugins > stargazers > worldmap > looking for ${location}`)
      if (!cache.has(location)) {
        try {
          const {data:{results}} = await get.geocode({params:{address:location, key:token}})
          const country = results.at(0).address_components.find(({types}) => types.includes("country"))
          cache.set(location, country.short_name ?? country.long_name)
          console.debug(`metrics/compute/${login}/plugins > stargazers > worldmap > ${location} resolved to ${cache.get(location)}`)
        }
        catch (error) {
          console.debug(`metrics/compute/${login}/plugins > stargazers > worldmap > failed to resolve ${location}: ${error}`)
        }
      }
      const code = cache.get(location)
      stars.set(code, (stars.get(code) ?? 0) + 1)
    }
  }
  else throw {error:{message:"Google Maps API token is not set"}}

  //Generate SVG
  const d3n = new D3Node()
  const svg = d3n.createSVG(480, 315)
  const countries = JSON.parse(await imports.fs.readFile(imports.paths.join(imports.__module(import.meta.url), "50m_countries.geojson")))
  const geopath = d3.geoPath(d3.geoMercator().fitWidth(svg.attr("width"), countries))
  const splits = [...new Set(stars.values())].sort((a, b) => a - b)
  svg
    .append("g")
    .selectAll("path")
    .data(countries.features)
    .join("path")
    .attr("id", ({id}) => id)
    .style("fill", ({properties:{iso_a2, wb_a2, sov_a3}}) => {
      const code = iso_a2?.match(/[A-Z]{2}/) ? iso_a2 : wb_a2?.match(/[A-Z]{2}/) ? wb_a2 : sov_a3?.substr(0, 2) ?? ""
      const value = stars.get(code)
      return color("#216e39").mix(color("#ffffff"), 1 - Math.max(0, splits.indexOf(value))/splits.length).hex();
    })
    .style("stroke", "#afafaf")
    .style("stroke-width", "0.6px")
    .attr("d", geopath)

  return d3n.svgString()
}
