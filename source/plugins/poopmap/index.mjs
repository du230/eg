//Setup
export default async function({_login, q, imports, data, _computed, _rest, _graphql, _queries, account}, {enabled = false} = {}) {
  //Plugin execution
  try {
    //Check if plugin is enabled and requirements are met
    if ((!enabled)||(!q.poopmap))
      return null

    const {token, days} = imports.metadata.plugins.poopmap.inputs({data, account, q})

    const {data:{poops}} = imports.axios.get(`https://api.poopmap.net/api/v1/public_links/${token}`)

    const filteredPoops = poops.filter(poop => {
      const createdAt = new Date(poop.created_at)
      const now = new Date().getTime()
      //Days * hours * minutes * seconds * milliseconds
      const timeframe = now - (days ?? 7) * 24 * 60 * 60 * 1000

      poop.created_at = createdAt.toString()

      return createdAt.getTime() > timeframe
    })

    for (let i = 0; i < filteredPoops.length; i++) {
      const poop = filteredPoops[i]
      const hour = new Date(poop.created_at).getHours()
      if (!poops[hour]) poops[hour] = 1
      else poops[hour] += 1

      if (!poops.max || poops[hour] > poops.max) poops.max = poops[hour]
    }

    //Results
    return {poops, days}
  }
  //Handle errors
  catch (error) {
    throw {error:{message:"An error occured", instance:error}}
  }
}