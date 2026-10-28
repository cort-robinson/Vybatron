package app.vybatron.playback

import org.json.JSONObject

/** A song as the portal sends it, with a YouTube link unless `uri` says otherwise. */
fun song(name: String, uri: String? = "https://www.youtube.com/watch?v=${name.padEnd(11, '0').take(11)}"): NativeTrack =
    NativeTrack.parse(JSONObject()
        .put("id", name).put("title", name.uppercase()).put("author", "M83").put("uri", uri ?: JSONObject.NULL)
        .put("source", "youtube").put("durationMs", 240_000).put("artworkUrl", JSONObject.NULL).put("isStream", false)
        .put("requestedBy", JSONObject().put("id", "1").put("displayName", "Someone").put("avatarUrl", JSONObject.NULL)))!!
