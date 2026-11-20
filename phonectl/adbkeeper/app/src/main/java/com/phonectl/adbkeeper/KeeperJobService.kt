package com.phonectl.adbkeeper

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.util.Log

class KeeperJobService : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        val settings = DebugSettings(contentResolver)
        settings.enableWirelessDebugging()
        settings.keepAwakeWhilePluggedIn()
        return false // Writes are complete; no asynchronous work remains.
    }

    override fun onStopJob(params: JobParameters): Boolean = false

    companion object {
        private const val JOB_ID = 1

        internal fun schedule(context: Context) {
            val scheduler = context.getSystemService(JobScheduler::class.java)
            // Repeated boot broadcasts must not reset the existing job's window.
            if (scheduler.getPendingJob(JOB_ID) != null) return
            val job = JobInfo.Builder(JOB_ID, ComponentName(context, KeeperJobService::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED)
                .setPeriodic(15 * 60 * 1000L)
                .setPersisted(true)
                .build()
            if (scheduler.schedule(job) == JobScheduler.RESULT_FAILURE) {
                Log.e("adbkeeper", "Failed to schedule keeper job")
            } else {
                Log.i("adbkeeper", "Scheduled unmetered keeper job")
            }
        }
    }
}
