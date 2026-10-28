package app.youmusic

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.HapticFeedbackConstants
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updateLayoutParams
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.youmusic.bridge.BridgeHost
import app.youmusic.bridge.CommandRegistry
import app.youmusic.bridge.EventBus
import app.youmusic.bridge.modules.AiModule
import app.youmusic.bridge.modules.CatalogModule
import app.youmusic.bridge.modules.LibraryModule
import app.youmusic.bridge.modules.ModsModule
import app.youmusic.bridge.modules.NetModule
import app.youmusic.bridge.modules.OfflineModule
import app.youmusic.bridge.modules.PlayerModule
import app.youmusic.bridge.modules.SystemModule
import app.youmusic.model.DeepLinkDto
import app.youmusic.model.InsetsDto
import app.youmusic.system.ActivityHost
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

class MainActivity : ComponentActivity(), ActivityHost {
    private lateinit var webView: WebView
    private var insets = InsetsDto(0f, 0f, 0f, 0f)
    private var pendingDeepLink: String? = null

    private val pickerLock = Mutex()
    private var pending: CompletableDeferred<Any?>? = null
    private lateinit var openMany: ActivityResultLauncher<Array<String>>
    private lateinit var openOne: ActivityResultLauncher<Array<String>>
    private lateinit var openTree: ActivityResultLauncher<Uri?>
    private lateinit var create: ActivityResultLauncher<Pair<String, String>>

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        registerPickers()

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            setContentView(TextView(this).apply {
                text = getString(R.string.webview_unsupported)
                setPadding(64, 256, 64, 64)
                setTextColor(Color.WHITE)
            })
            return
        }

        val root = FrameLayout(this).apply { setBackgroundColor(getColor(R.color.graphite_bg)) }
        webView = WebView(this).apply {
            setBackgroundColor(getColor(R.color.graphite_bg))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.textZoom = 100
            settings.setSupportZoom(false)
            overScrollMode = WebView.OVER_SCROLL_NEVER
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)

        val graph = YouMusicApp.graph
        val registry = CommandRegistry()
        listOf(
            SystemModule(applicationContext, graph.kv, graph.network, this),
            PlayerModule(graph.player),
            CatalogModule(graph.youtube, graph.lyrics, graph.artwork, graph.importer),
            LibraryModule(graph.library, graph.downloads),
            OfflineModule(graph.downloads, graph.local, graph.mediaCache, graph.paths, graph.kv, this),
            ModsModule(graph.mods, this),
            NetModule(applicationContext, graph.proxies, graph.updates),
            AiModule(graph.ai),
        ).forEach { it.register(registry) }

        val bridge = BridgeHost(lifecycleScope, registry)
        WebViewCompat.addWebMessageListener(webView, BridgeHost.OBJECT_NAME, setOf(BridgeHost.ORIGIN), bridge)
        lifecycleScope.launch { EventBus.events.collect(bridge::emit) }

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/art/", WebViewAssetLoader.InternalStoragePathHandler(this, graph.paths.art))
            .addPathHandler("/blur/", WebViewAssetLoader.InternalStoragePathHandler(this, graph.paths.blur))
            .addPathHandler("/mods/", WebViewAssetLoader.InternalStoragePathHandler(this, graph.paths.mods))
            .addPathHandler("/", UiPathHandler(this))
            .build()
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assets.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.toString().startsWith(BridgeHost.ORIGIN)) return false
                openUrl(request.url.toString())
                return true
            }
        }

        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, windowInsets ->
            val bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
            val density = resources.displayMetrics.density
            val imeVisible = ime.bottom > bars.bottom
            view.updateLayoutParams<FrameLayout.LayoutParams> { bottomMargin = if (imeVisible) ime.bottom else 0 }
            insets = InsetsDto(bars.top / density, if (imeVisible) 0f else bars.bottom / density, bars.left / density, bars.right / density)
            EventBus.emit("insets", insets)
            WindowInsetsCompat.CONSUMED
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = EventBus.emit("back", JsonObject(emptyMap()))
        })

        webView.loadUrl("${BridgeHost.ORIGIN}/index.html")
        handleDeepLink(intent)
        askNotificationPermission()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleDeepLink(intent)
    }

    /** youmusic:// links are kept until the UI asks for them (it may still be loading) and also pushed as an event. */
    private fun handleDeepLink(intent: Intent?) {
        val data = intent?.data?.takeIf { it.scheme == "youmusic" } ?: return
        pendingDeepLink = data.toString()
        EventBus.emit("deepLink", DeepLinkDto(data.toString()))
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    override fun consumeDeepLink(): String? = pendingDeepLink.also { pendingDeepLink = null }

    override fun onDestroy() {
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }

    private fun registerPickers() {
        openMany = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { complete(it) }
        openOne = registerForActivityResult(ActivityResultContracts.OpenDocument()) { complete(listOfNotNull(it)) }
        openTree = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { complete(it) }
        create = registerForActivityResult(CreateTypedDocument()) { complete(it) }
    }

    private fun complete(value: Any?) {
        pending?.complete(value)
        pending = null
    }

    private suspend fun <T> awaitPicker(launch: () -> Unit): T? = pickerLock.withLock {
        val deferred = CompletableDeferred<Any?>()
        withContext(Dispatchers.Main) {
            pending = deferred
            launch()
        }
        @Suppress("UNCHECKED_CAST")
        deferred.await() as T?
    }

    override suspend fun pickDocuments(mimeTypes: Array<String>, multiple: Boolean): List<Uri> =
        awaitPicker<List<Uri>> { if (multiple) openMany.launch(mimeTypes) else openOne.launch(mimeTypes) }.orEmpty()

    override suspend fun pickTree(): Uri? = awaitPicker { openTree.launch(null) }

    override suspend fun createDocument(name: String, mime: String): Uri? = awaitPicker { create.launch(name to mime) }

    override fun haptic(kind: String) {
        runOnUiThread {
            val constant = when (kind) {
                "confirm" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
                "medium" -> HapticFeedbackConstants.KEYBOARD_TAP
                else -> HapticFeedbackConstants.CLOCK_TICK
            }
            webView.performHapticFeedback(constant)
        }
    }

    override fun share(text: String) {
        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), null))
    }

    override fun openUrl(url: String) {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
    }

    override fun moveToBack() {
        runOnUiThread { moveTaskToBack(true) }
    }

    override fun setLightSystemBars(light: Boolean) {
        runOnUiThread {
            WindowCompat.getInsetsController(window, window.decorView).apply {
                isAppearanceLightStatusBars = light
                isAppearanceLightNavigationBars = light
            }
        }
    }

    override fun insets(): InsetsDto = insets

    /** CreateDocument with the MIME type chosen per call. */
    private class CreateTypedDocument : ActivityResultContract<Pair<String, String>, Uri?>() {
        override fun createIntent(context: Context, input: Pair<String, String>) =
            Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(input.second)
                .putExtra(Intent.EXTRA_TITLE, input.first)

        override fun parseResult(resultCode: Int, intent: Intent?): Uri? = intent?.data.takeIf { resultCode == RESULT_OK }
    }
}
